import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { Flip } from 'gsap/Flip';
import { createSmartStoreBabylonScene, validateShelfLayout, validateUsers } from '../scenes/smartStoreBabylon.js';
import { apiFetch } from '../api';

gsap.registerPlugin(Flip);

/* ---------- tiny presentational helpers ---------- */

// Person avatar chip: the API customer's `avatar_url` as an <img>, falling back
// to the initials chip (torso-tinted) when there's no url, it fails to load, or
// the person is a walk-in (avatarUrl ''). Key this by url at the call site so a
// changed url remounts and clears a stale onError.
function PersonAvatar({ person, className = '' }) {
  const [broken, setBroken] = useState(false);
  const cls = `pc-avatar${className ? ` ${className}` : ''}`;
  return person.avatarUrl && !broken ? (
    // no-referrer: googleusercontent avatars 403 hotlinked requests that carry a
    // Referer header — without this the photo errors out to the chip fallback
    <img className={`${cls} pc-avatar-img`} src={person.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  ) : (
    <span className={cls} style={{ background: person.color }}>{person.initials}</span>
  );
}

// A smooth SVG sparkline from a list of values.
function Spark({ data, color = '#35c3ff', w = 200, h = 42 }) {
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => [i * step, h - ((v - min) / span) * (h - 6) - 3]);
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const area = `${d} L${w},${h} L0,${h} Z`;
  const id = `g${color.replace('#', '')}`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Donut chart for online / offline shelves.
function Donut({ online, offline }) {
  const total = online + offline;
  const r = 46, c = 2 * Math.PI * r;
  const onLen = (online / total) * c;
  return (
    <svg className="donut" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r={r} fill="none" stroke="#16294f" strokeWidth="14" />
      <circle
        cx="60" cy="60" r={r} fill="none" stroke="#35c3ff" strokeWidth="14"
        strokeLinecap="round" strokeDasharray={`${onLen} ${c - onLen}`}
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="56" className="donut-num">{online}</text>
      <text x="60" y="74" className="donut-sub">online</text>
    </svg>
  );
}

const STAT_CARDS = [
  { k: 'Total Sales (Today)', v: '24,560', u: '฿', d: '+18.6%', spark: [12, 14, 13, 16, 15, 19, 18, 22, 21, 24], color: '#35c3ff' },
  { k: 'Customers', v: '362', u: '', d: '+12.3%', spark: [8, 9, 11, 10, 13, 12, 15, 14, 17, 18], color: '#4caf72' },
  { k: 'Conversion Rate', v: '28.5', u: '%', d: '+2.4%', spark: [20, 22, 21, 24, 23, 25, 26, 27, 28, 28], color: '#4caf72' },
  { k: 'Average Dwell Time', v: '6m 24', u: 's', d: '+8.1%', spark: [4, 5, 5, 6, 6, 7, 6, 8, 7, 8], color: '#4caf72' },
];

// ---------- data source ----------
// The whole shelf catalogue — ids, names, layout, online flags AND the item
// stock — comes from the shelfs API (GET /shelfs), which fetches the live
// layout from the external IoT devices feed and maps it onto the Shelf shape.
// The 3D scene builds its shelves from that same parsed data (single source of
// truth); validateShelfLayout (from the scene module) rejects layouts the fixed
// store architecture can't support before anything renders. The customer roster comes from the
// users API (apps/api — an in-memory stand-in for the future external users
// service): GET seeds the shoppers already in the store at open, and its SSE
// feed drives live walk-ins (POST), card updates / body swaps (PATCH) and
// fade-outs (DELETE) while the demo runs.
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3004';
const USERS_API_URL = `${API_URL}/users`;
const CROWD_API_URL = `${API_URL}/crowd`;
// shelf-scan sessions feed — loadcell pick/return events arrive here and drive
// the shopper's pick/return gesture (the row's userId maps to the 3D body).
const SESSIONS_API_URL = `${API_URL}/sessions`;
// shelves come from the API too now — it fetches the live layout from the
// external IoT devices feed and maps it onto the Shelf shape (see apps/api).
const SHELFS_API_URL = `${API_URL}/shelfs`;

// Shelf ids are device_id strings (e.g. "10005" / "BF67EC"), but everywhere we
// show a shelf to the user we display its 1-based position instead (01, 02, …)
// so it matches the 3D badge. This module-level map is kept in sync with the
// loaded shelf order by the Dashboard render (see shelfIndexById below); the
// resolver falls back to the raw id if a shelf isn't in the current layout.
let shelfIndexMap = {};
const shelfIdStr = (id) => shelfIndexMap[id] ?? String(id);

// shelf lock mirror (V5): the scene owns the state and streams transitions up
// via onShelfEvent; this map only drives the UI chips. Offline shelves can't
// unlock — mirrors the scene's red-LED rule.
const LOCK_LABEL = { locked: 'Locked', open: 'Open', offline: 'Offline' };
const LOCK_EVENT_META = {
  unlocked: { lvl: 'ok', title: 'Shelf Unlocked', ico: '🔓' },
  relocked: { lvl: 'info', title: 'Shelf Re-locked', ico: '🔒' },
  scan_ok: { lvl: 'ok', title: 'Access Granted', ico: '📱' },
};

// stock level → status; `rank` orders them so we only alert when it gets worse.
const statusOf = (qty, reorder) => (qty <= 0 ? 'out' : qty <= reorder ? 'low' : 'ok');
const statusRank = { ok: 0, low: 1, out: 2 };
const statusLabel = { ok: 'OK', low: 'Low', out: 'Out' };

const fmtTime = (d) =>
  d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

let alertSeq = 0;

const ENV = [
  ['Temperature', '23.6', '°C', 'Optimal', 'ok'],
  ['Humidity', '45', '%', 'Optimal', 'ok'],
  ['CO₂ Level', '560', 'ppm', 'Good', 'ok'],
  ['Air Quality', 'Good', '', 'PM2.5 12', 'ok'],
];

const NAV = ['STORE OVERVIEW', 'SHELF STATUS', 'ANALYTICS', 'ALERTS'];
const BOTTOM = [
  ['Dashboard', '⌂'], ['Analytics', '📊'], ['Products', '🛍'], ['Alerts', '🔔'], ['Settings', '⚙'],
];

/* ---------- 3D center stage mount ---------- */
// `sceneFactory(container, { onSelectShelf }) => { dispose, selectShelf }` lets
// V4 (Three.js) and V5 (Babylon.js) share the exact same dashboard chrome —
// only the engine driving the center stage differs.
function StoreStage({ selectedShelf, selectedPerson, onSelectShelf, onSelectPerson, onShelfEvent, sceneFactory, onController, defer = false, onReady, shelves, users }) {
  const ref = useRef(null);
  const ctrlRef = useRef(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let controller = null;
    const create = () => {
      if (controller) return; // double-rAF and the timeout fallback can race
      controller = { dispose() {}, selectShelf() {} };
      try { controller = sceneFactory(container, { onSelectShelf, onSelectPerson, onReady, onShelfEvent, shelves, users }); }
      catch (e) { console.error('[storeStage] scene factory failed:', e); onReady?.(); }
      ctrlRef.current = controller;
      onController?.(controller);
    };
    let raf1 = 0, raf2 = 0, fallback = 0;
    if (!defer) {
      // Create directly — the container already has its committed layout size in
      // the effect, so we don't need to defer a frame (and some headless
      // environments throttle rAF, which would stall the deferred create).
      create();
    } else {
      // V5's synchronous scene build blocks the main thread for seconds — let
      // the browser paint the boot overlay first. Double rAF guarantees one
      // painted frame before the blocking work; the timeout is the safety net
      // for throttled/background tabs where rAF may take ~1s per tick.
      raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(create); });
      fallback = setTimeout(create, 500);
    }
    return () => {
      cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); clearTimeout(fallback);
      controller?.dispose(); ctrlRef.current = null; onController?.(null);
    };
    // created once; selection flows in via the sync effects below.
  }, [onSelectShelf, onSelectPerson, onShelfEvent, sceneFactory, onController, defer, onReady, shelves, users]);

  // React owns the selection — push it into the scene to drive the outline.
  useEffect(() => {
    ctrlRef.current?.selectShelf?.(selectedShelf);
  }, [selectedShelf]);
  // …and the person focus (V5 only; V4 has no people API, hence the chaining).
  useEffect(() => {
    ctrlRef.current?.people?.select?.(selectedPerson);
  }, [selectedPerson]);

  return <div className="store-stage" ref={ref} />;
}

/* ---------- heatmap (radial blobs on a tinted floor) ---------- */
function Heatmap() {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const blobs = [
      [0.3, 0.35, 28, 1], [0.55, 0.3, 22, 0.8], [0.7, 0.55, 30, 1],
      [0.4, 0.65, 24, 0.9], [0.2, 0.6, 18, 0.6], [0.78, 0.78, 16, 0.5],
      [0.5, 0.5, 20, 0.7],
    ];
    ctx.fillStyle = 'rgba(10,20,42,0.6)';
    ctx.fillRect(0, 0, W, H);
    blobs.forEach(([x, y, rad, a]) => {
      const g = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, rad);
      g.addColorStop(0, `rgba(255,60,40,${a})`);
      g.addColorStop(0.4, `rgba(255,170,40,${a * 0.7})`);
      g.addColorStop(0.75, `rgba(60,180,255,${a * 0.35})`);
      g.addColorStop(1, 'rgba(60,180,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    });
  }, []);
  return <canvas className="heatmap-cv" ref={ref} width={300} height={150} />;
}

/* ---------- one live-stock row (flashes briefly when its qty changes) ---------- */
function StockRow({ item }) {
  const [flash, setFlash] = useState(false);
  const prevQty = useRef(item.qty);
  useEffect(() => {
    if (prevQty.current === item.qty) return;
    prevQty.current = item.qty;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 600);
    return () => clearTimeout(t);
  }, [item.qty]);

  const status = statusOf(item.qty, item.reorder);
  const pct = Math.max(0, Math.min(100, (item.qty / item.capacity) * 100));
  return (
    <li className={`stk-row${flash ? ' flash' : ''}`}>
      <span className="stk-dot" style={{ background: item.color }} />
      <div className="stk-main">
        <div className="stk-top">
          <span className="stk-name">{item.name}</span>
          <span className="stk-qty">{item.qty}<small>/{item.capacity}</small></span>
        </div>
        <div className="stk-bar-track">
          <div className={`stk-bar-fill ${status}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className={`stk-pill ${status}`}>{statusLabel[status]}</span>
    </li>
  );
}

/* ---------- floating shelf inspector (pinned bottom-left of the 3D stage) ---------- */
// Mirrors V3's detail card: a small <dl> summary that opens when a shelf is
// focused. Content is V4-native — the full item list lives in LIVE STOCK.
function ShelfDetailCard({ detail, onClose }) {
  const { id, name, online, lock, items } = detail;
  const totalQty = items.reduce((s, it) => s + it.qty, 0);
  const totalCap = items.reduce((s, it) => s + it.capacity, 0);
  const low = items.filter((it) => statusOf(it.qty, it.reorder) === 'low').length;
  const out = items.filter((it) => statusOf(it.qty, it.reorder) === 'out').length;
  return (
    <div className="store-detail-card">
      <button className="detail-close" onClick={onClose} title="Close (Esc)">✕</button>
      <div className="detail-head">
        <span className={`sd-dot ${online ? 'on' : 'off'}`} />
        <span className="detail-title">{id} · {name}</span>
      </div>
      <dl className="detail-rows">
        <dt>Status</dt><dd>{online ? 'Online' : 'Offline'}</dd>
        {lock && <><dt>Lock</dt><dd><span className={`lock-txt ${lock}`}>{lock === 'open' ? '🔓 ' : '🔒 '}{LOCK_LABEL[lock]}</span></dd></>}
        <dt>Products</dt><dd>{items.length}</dd>
        <dt>Stock</dt><dd>{totalQty} / {totalCap}</dd>
        <dt>Low / Out</dt><dd>{low} · {out}</dd>
      </dl>
    </div>
  );
}

/* ---------- floating person card (follows the shopper on screen, V5 only) ---------- */
// The scene writes this wrapper's transform every frame (world → screen
// projection, clamped to the stage edges) — React only renders the content,
// refreshed at 2 Hz from the sim while a person is selected.
const PERSON_STATUS = {
  walking: 'Walking', paying: 'Paying', leaving: 'Leaving',
  browsing: 'Browsing', scanning: 'Scanning', verifying: 'Verifying',
};
const fmtDur = (s) => `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;

function PersonDetailCard({ person, onClose, bindEl, shelfName }) {
  return (
    <div className="person-card-track" ref={bindEl}>
      <div className="store-detail-card person-card">
        <button className="detail-close" onClick={onClose} title="Close (Esc)">✕</button>
        <div className="detail-head pc-head">
          <PersonAvatar key={person.avatarUrl || 'chip'} person={person} />
          <span className="pc-id">
            <span className="detail-title">{person.name}</span>
            <span className="pc-cust">CUSTOMER {person.custNo}</span>
          </span>
        </div>
        <dl className="detail-rows">
          <dt>Status</dt><dd>{PERSON_STATUS[person.status]}</dd>
          {person.email ? <><dt>Email</dt><dd className="pc-email">{person.email}</dd></> : null}
          <dt>Near</dt><dd>{shelfName[person.near] ?? '—'} ({shelfIdStr(person.near)})</dd>
          <dt>In store</dt><dd>{fmtDur(person.inStoreSec)}</dd>
          <dt>Items picked</dt><dd>{person.picks}</dd>
        </dl>
      </div>
    </div>
  );
}

/* ---------- customers card (V5 only — everyone currently in the store) ---------- */
// Rows group by status (at-shelf → walking → gates); within a group the id
// order is stable so rows only move when someone actually changes status, and
// that move is FLIP-animated. Clicking a row focuses the person in 3D.
const STATUS_ORDER = { scanning: 0, browsing: 1, walking: 2, verifying: 3, paying: 4, leaving: 5 };

// initials (first + last word) for roster rows that have no 3D body to borrow
// them from — the "exited" customers pulled straight from the users API.
const custInitials = (name) => {
  const w = (name || '?').trim().split(/\s+/);
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase() || '?';
};
// muted slate for the exited-row avatar chip fallback (no torso tint to borrow)
const EXITED_CHIP = '#3d4a63';

function CustomersCard({ peopleRef, crowd, outsideUsers, selectedPerson, onSelect, shelfName }) {
  const [list, setList] = useState([]);
  const ulRef = useRef(null);
  const flipState = useRef(null);

  // email tooltip — a single fixed-position node placed on hover of a name, so
  // it escapes the list's overflow-y:auto clipping (only API customers carry an
  // email; walk-ins don't trigger it). Cleared on mouse-leave / row change.
  const [tip, setTip] = useState(null); // { email, x, y } | null
  const showTip = useCallback((email, el) => {
    const r = el.getBoundingClientRect();
    setTip({ email, x: r.left, y: r.top });
  }, []);
  const hideTip = useCallback(() => setTip(null), []);

  // "exited" customers — the ones the API says are `outside`, so they have no
  // 3D body and never appear in the scene's list(). The Dashboard mirrors the
  // roster off the SSE feed (authoritative status source) and hands the
  // outside slice down; render them dimmed at the tail of the list.
  const outside = useMemo(
    () =>
      outsideUsers.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        avatarUrl: u.avatar_url ?? '',
        initials: custInitials(u.name),
        color: EXITED_CHIP,
      })),
    [outsideUsers],
  );

  useEffect(() => {
    const read = () => {
      const rows = (peopleRef.current?.list?.() ?? [])
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id - b.id);
      // capture row positions before React reorders them — the FLIP below
      // animates from this snapshot to the committed layout.
      if (ulRef.current) flipState.current = Flip.getState(ulRef.current.children);
      setList(rows);
    };
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
    // `crowd` re-reads immediately when the steppers change the head-count.
  }, [peopleRef, crowd]);

  useLayoutEffect(() => {
    const state = flipState.current;
    flipState.current = null;
    if (!state || !ulRef.current) return;
    Flip.from(state, {
      targets: ulRef.current.children,
      duration: 0.3,
      ease: 'power2.out',
      onEnter: (els) =>
        gsap.fromTo(els, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, clearProps: 'opacity,transform' }),
    });
  }, [list]);

  // one row per customer: while a body is still on the floor (walking out
  // after a pay pass, retreating after a verify fail) the API may already say
  // `outside` — the live row wins until the body despawns, so the Exited row
  // for the same person never shows alongside it.
  const liveApiIds = new Set(list.map((p) => p.apiId).filter((v) => v != null));
  const shownOutside = outside.filter((u) => !liveApiIds.has(u.id));

  return (
    <section className="card">
      <div className="card-head">
        <h2>CUSTOMERS</h2>
        <span className="pill">{list.length} in store</span>
      </div>
      <ul className="cust-list" ref={ulRef}>
        {list.length || shownOutside.length ? (
          <>
            {list.map((p) => (
              <li
                key={p.id}
                data-flip-id={`cust-${p.id}`}
                className={`cust-row${selectedPerson === p.id ? ' active' : ''}`}
                onClick={() => onSelect(p.id)}
              >
                <PersonAvatar key={p.avatarUrl || 'chip'} person={p} className="cust-avatar" />
                <div className="cust-main">
                  <div className="cust-top">
                    <span
                      className={`cust-name${p.email ? ' has-tip' : ''}`}
                      onMouseEnter={p.email ? (e) => showTip(p.email, e.currentTarget) : undefined}
                      onMouseLeave={p.email ? hideTip : undefined}
                    >
                      {p.name}
                    </span>
                    <span className={`cust-tag ${p.api ? 'api' : 'random'}`}>{p.api ? 'API' : 'AUTO'}</span>
                    <span className={`cust-pill ${p.status}`}>{PERSON_STATUS[p.status]}</span>
                  </div>
                  <div className="cust-sub">
                    {shelfName[p.near] ?? '—'} ({shelfIdStr(p.near)}) · {fmtDur(p.inStoreSec)}
                  </div>
                </div>
              </li>
            ))}
            {/* exited customers (API `outside`) — always at the tail, dimmed and
                non-clickable: there's no 3D body to focus. Email shows inline. */}
            {shownOutside.map((u) => (
              <li
                key={`out-${u.id}`}
                data-flip-id={`cust-out-${u.id}`}
                className="cust-row cust-row-exited"
              >
                <PersonAvatar key={u.avatarUrl || 'chip'} person={u} className="cust-avatar" />
                <div className="cust-main">
                  <div className="cust-top">
                    <span className="cust-name">{u.name}</span>
                    <span className="cust-tag api">API</span>
                    <span className="cust-pill exited">Exited</span>
                  </div>
                  <div className="cust-sub">{u.email}</div>
                </div>
              </li>
            ))}
          </>
        ) : (
          <li className="stk-empty">No customers in store</li>
        )}
      </ul>
      {tip
        ? createPortal(
            // portal to <body> so the fixed tooltip isn't offset by the card's
            // residual intro-animation transform (a transformed ancestor would
            // otherwise become its containing block)
            <div className="cust-email-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
              {tip.email}
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

/* ---------- main dashboard ---------- */
export default function Dashboard({ sceneFactory = createSmartStoreBabylonScene, deferScene = false }) {
  const rootRef = useRef(null);
  const [tab, setTab] = useState(0);
  const [floor, setFloor] = useState(0);
  const [view3d, setView3d] = useState(true);
  // sidebar collapse — independent, visual-only (CSS hide, no unmount) so
  // polling underneath keeps running and a re-open shows live data. Not
  // persisted: every load starts with both panels open.
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // ---- mock data (shelf catalogue + customer roster): fetched, validated,
  // then everything derives ----
  const [catalog, setCatalog] = useState(null);   // { shelves: [...], users: [...] } once loaded
  const [loadError, setLoadError] = useState(null);
  const loadCatalog = useCallback(() => {
    setLoadError(null);
    setCatalog(null);
    // both shelves and users come from the API now (both enveloped); apiFetch
    // returns each array already unwrapped. The shelfs endpoint fetches the live
    // IoT device layout on every call, so a failure here surfaces as a load error.
    Promise.all([apiFetch(SHELFS_API_URL), apiFetch(USERS_API_URL)])
      .then(([shelfData, userData]) => {
        const errors = [...validateShelfLayout(shelfData), ...validateUsers(userData)];
        if (errors.length) throw new Error(errors.join(' · '));
        setCatalog({ shelves: shelfData, users: userData });
      })
      .catch((e) => setLoadError(String(e?.message || e)));
  }, []);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  // stable identity — `?? []` inline would mint a new array every render and
  // cascade through the memos below into an effect loop while catalog is null
  const shelvesDef = useMemo(() => catalog?.shelves ?? [], [catalog]);
  // device_id → 1-based padded index (01, 02, …), matching the 3D badge order.
  // Assigned to the module-level shelfIndexMap so shelfIdStr() resolves ids to
  // indices everywhere — including child cards and ref-based scene callbacks —
  // without threading a prop. Idempotent, so a render-time assignment is safe.
  const shelfIndexById = useMemo(
    () => Object.fromEntries(shelvesDef.map((s, i) => [s.id, String(i + 1).padStart(2, '0')])), [shelvesDef]);
  shelfIndexMap = shelfIndexById;
  const shelfName = useMemo(
    () => Object.fromEntries(shelvesDef.map((s) => [s.id, s.name])), [shelvesDef]);
  const offlineShelves = useMemo(
    () => new Set(shelvesDef.filter((s) => !s.online).map((s) => s.id)), [shelvesDef]);
  const lockInit = useMemo(
    () => Object.fromEntries(shelvesDef.map((s) => [s.id, s.online ? 'locked' : 'offline'])), [shelvesDef]);
  // refs so the stable callbacks below (scene contract — must not change
  // identity, or StoreStage tears the scene down) can read the loaded data
  const shelfNameRef = useRef({});
  shelfNameRef.current = shelfName;
  const lockInitRef = useRef(lockInit);
  lockInitRef.current = lockInit;

  // Boot overlay (deferScene versions only): covers the dash until the scene's
  // first frame is on screen, so the heavy synchronous scene build never shows
  // as a frozen half-drawn dashboard. The scene signals readiness via onReady.
  const [booting, setBooting] = useState(deferScene);
  const handleReady = useCallback(() => setBooting(false), []);

  // Entrance: stagger the big blocks in once on mount. Scoped to `.dash` so the
  // selectors can't reach outside this dashboard. `.is-armed` (set in JSX) hides
  // the targets up front via CSS so there's no flash before this runs; matchMedia
  // owns the reveal in BOTH paths, so the blocks can never get stuck hidden.
  // While booting, hold the entrance — it replays when the overlay lifts, so the
  // reveal lands after the 3D stage is live instead of freezing mid-stagger.
  useGSAP(() => {
    if (booting || !catalog) return;
    const root = rootRef.current;
    const targets = '.dash-head, .col-left .card, .store-stage, .col-right .card, .dash-bottom';
    const mm = gsap.matchMedia();

    mm.add('(prefers-reduced-motion: reduce)', () => {
      root.classList.remove('is-armed'); // reveal instantly, no motion
    });
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      // fromTo (not from): the `.is-armed` CSS already pins the targets to the
      // hidden state, so a plain from() would read "0" as the end too. The
      // immediate from-vars keep them hidden with no flash; dropping `.is-armed`
      // up front means clearProps at the end falls back to visible, not hidden.
      root.classList.remove('is-armed');
      gsap.fromTo(
        targets,
        { opacity: 0, y: 14 },
        {
          opacity: 1,
          y: 0,
          duration: 0.45,
          ease: 'power3.out',
          stagger: 0.07,
          clearProps: 'opacity,transform',
        }
      );
    });
  }, { scope: rootRef, dependencies: [booting, catalog] });

  // crowd stepper — only rendered when the scene exposes a `people` API (V5).
  const peopleRef = useRef(null);
  const [crowd, setCrowd] = useState(null); // { total, walking, browsing, maxTotal } or null

  // shelf lock mirror — seeded from the catalogue; scene → onShelfEvent → here.
  const [locksLive, setLocksLive] = useState(false);
  const [shelfLockMap, setShelfLockMap] = useState({});
  useEffect(() => { setShelfLockMap(lockInit); }, [lockInit]);
  const sceneCtrlRef = useRef(null);
  const floorRef = useRef(0);
  floorRef.current = floor;
  const handleController = useCallback((ctrl) => {
    sceneCtrlRef.current = ctrl ?? null;
    ctrl?.setFloor?.(floorRef.current); // sync the current floor once the scene is live
    peopleRef.current = ctrl?.people ?? null;
    setCrowd(ctrl?.people ? { ...ctrl.people.counts(), maxTotal: ctrl.people.maxTotal } : null);
    // lock UI only renders when the scene actually simulates locks (V5)
    setLocksLive(!!ctrl?.locks);
    setShelfLockMap(ctrl?.locks
      ? Object.fromEntries(ctrl.locks.states().map((s) => [s.id, s.state]))
      : lockInitRef.current);
  }, []);
  // FLOOR PLAN buttons: Floor 2 stacks a second storey in the scene, Floor 1/3 collapse it
  useEffect(() => { sceneCtrlRef.current?.setFloor?.(floor); }, [floor]);
  // the random crowd is driven from the Backdoor now (→ /crowd → SSE below),
  // not from a dashboard stepper. This page just mirrors the live head-count.
  useEffect(() => {
    const es = new EventSource(`${CROWD_API_URL}/events`);
    es.addEventListener('crowd', (ev) => {
      let target;
      try { target = JSON.parse(ev.data)?.target; } catch { return; }
      if (typeof target === 'number') peopleRef.current?.setCrowdTarget?.(target);
    });
    return () => es.close();
  }, []);
  // shelf-scan sessions feed: a real loadcell pick/return off a shelf plays the
  // matching gesture on the shopper the session belongs to (userId → 3D body).
  // Reuses the same inspectItemUser the users `inspectItem` event drives; a
  // pick maps to 'keep' (into the basket), a return to 'return' (back on shelf).
  useEffect(() => {
    const es = new EventSource(`${SESSIONS_API_URL}/events`);
    const gesture = (result) => (ev) => {
      let s;
      try { s = JSON.parse(ev.data); } catch { return; }
      if (s && typeof s.userId === 'number') peopleRef.current?.inspectItemUser?.(s.userId, result);
    };
    es.addEventListener('picked', gesture('keep'));
    es.addEventListener('returned', gesture('return'));
    return () => es.close();
  }, []);
  // pull the current target once the scene is ready so it matches the API
  useEffect(() => {
    if (!crowd) return;
    apiFetch(CROWD_API_URL)
      .then((d) => { if (d) peopleRef.current?.setCrowdTarget?.(d.target); })
      .catch(() => {});
  }, [crowd?.maxTotal]);
  // walking/browsing are outcomes of the sim (shoppers decide for themselves
  // when to stop at a shelf), so the live labels poll instead of tracking
  // stepper presses. No-ops until the V5 scene hands over its people API.
  useEffect(() => {
    const t = setInterval(() => {
      const c = peopleRef.current?.counts?.();
      if (c) setCrowd((prev) => (prev ? { ...prev, ...c } : prev));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // users API live feed — curl the API and watch the store react: POST walks
  // a new customer in, PATCH renames/reshapes them, DELETE fades them out.
  // EventSource reconnects by itself; events for people the scene doesn't
  // know are ignored there, so a dropped event can't wedge anything.
  // The same feed keeps a roster mirror so the CUSTOMERS card can show the
  // `outside` slice (Exited rows) without polling. Lifecycle events (added/
  // updated/enter/leave) carry the full User and merge straight in; verdict
  // events (verify/pay/scanQR/…) carry only { id, result } — they say an
  // action happened but not where the user's status landed, so those trigger
  // one debounced re-fetch instead of this code guessing the lifecycle.
  const [outsideUsers, setOutsideUsers] = useState([]);

  // verify/pay-pass image flash: an API `verify` or `pay` (result pass) that
  // carries an imageURL pops a bubble with the customer's face above their head
  // in the 3D scene for ~2s, then fades out (`closing` drives the fade-out CSS).
  // The reveal is deferred to the scene: armVerifyFlash arms it, and the bubble
  // only shows (and the 2s clock only starts) once the in-scene scan beam sweeps
  // that customer through — the scene calls back via armFlash's onReveal. If no
  // sweep ever comes (no body / despawns first) it's dropped, never shown.
  // One shared slot (latest revealed pass wins) — `label` is the only difference
  // ("Verified ✓" vs "Paid ✓"). Timers live in a ref so the reveal, the
  // auto-dismiss, and the broken-image close all share and cancel the same
  // handles. The scene owns the per-frame follow transform.
  const [verifyFlash, setVerifyFlash] = useState(null); // { imageURL, name, label } | null
  const [verifyFlashClosing, setVerifyFlashClosing] = useState(false);
  const verifyFlashTimers = useRef([]);
  const clearVerifyFlashTimers = useCallback(() => {
    verifyFlashTimers.current.forEach(clearTimeout);
    verifyFlashTimers.current = [];
  }, []);
  const closeVerifyFlash = useCallback(() => {
    clearVerifyFlashTimers();
    setVerifyFlash(null);
    setVerifyFlashClosing(false);
  }, [clearVerifyFlashTimers]);
  const showVerifyFlash = useCallback((imageURL, name, label) => {
    clearVerifyFlashTimers();
    setVerifyFlashClosing(false);
    setVerifyFlash({ imageURL, name, label });
    // hold 2s, then flip to the fade-out; unmount once the 400ms fade finishes
    verifyFlashTimers.current.push(setTimeout(() => setVerifyFlashClosing(true), 2000));
    verifyFlashTimers.current.push(setTimeout(() => {
      setVerifyFlash(null);
      setVerifyFlashClosing(false);
    }, 2400));
  }, [clearVerifyFlashTimers]);
  // arm on the SSE pass; the scene reveals it (→ showVerifyFlash) only when the
  // scan beam clears this customer, and drops it silently otherwise.
  const armVerifyFlash = useCallback((imageURL, name, label, apiId) => {
    peopleRef.current?.armFlash?.(apiId, (revealed) => {
      if (revealed) showVerifyFlash(imageURL, name, label);
    });
  }, [showVerifyFlash]);
  useEffect(() => clearVerifyFlashTimers, [clearVerifyFlashTimers]); // drop timers on unmount
  // hand the bubble wrapper to the scene, which writes its follow transform
  const bindVerifyFlash = useCallback((el) => { peopleRef.current?.bindFlash?.(el); }, []);

  useEffect(() => {
    const es = new EventSource(`${USERS_API_URL}/events`);
    const roster = new Map();
    const publish = () =>
      setOutsideUsers(
        [...roster.values()].filter((u) => u.status === 'outside').sort((a, b) => a.id - b.id),
      );
    // wholesale replace from GET /users; a failed fetch keeps the last map
    const sync = () => {
      apiFetch(USERS_API_URL)
        .then((users) => {
          if (!Array.isArray(users)) return;
          roster.clear();
          for (const u of users) roster.set(u.id, u);
          publish();
        })
        .catch(() => {});
    };
    let syncT = 0;
    const syncSoon = () => { clearTimeout(syncT); syncT = setTimeout(sync, 300); };
    const fwd = (fn, gone = false) => (ev) => {
      let user;
      try { user = JSON.parse(ev.data); } catch { return; }
      if (gone) roster.delete(user.id);
      else roster.set(user.id, { ...roster.get(user.id), ...user });
      publish();
      if (!gone && user.status == null) syncSoon();
      fn(user);
    };
    // seed + heal: `open` fires on first connect and on every auto-reconnect,
    // so one sync here both boots the roster and repairs whatever events were
    // missed while the connection was down.
    es.addEventListener('open', sync);
    es.addEventListener('added', fwd((u) => peopleRef.current?.addUser?.(u)));
    es.addEventListener('updated', fwd((u) => peopleRef.current?.updateUser?.(u)));
    es.addEventListener('removed', fwd((u) => peopleRef.current?.removeUser?.(u.id), true));
    es.addEventListener('leave', fwd((u) => peopleRef.current?.leaveUser?.(u.id)));
    es.addEventListener('enter', fwd((u) => peopleRef.current?.enterUser?.(u)));
    es.addEventListener('verify', fwd((u) => {
      peopleRef.current?.verifyUser?.(u.id, u.result);
      // a pass that carried a face photo arms a bubble above that shopper's
      // head; it only reveals when the entrance scan beam clears them. The name
      // comes from the roster mirror (fwd merged this event in just above).
      if (u.result === 'pass' && u.imageURL) {
        armVerifyFlash(u.imageURL, roster.get(u.id)?.name, 'Verified ✓', u.id);
      }
    }));
    es.addEventListener('pay', fwd((u) => {
      peopleRef.current?.payUser?.(u.id, u.result);
      // same head bubble as verify, on a pay pass (label "Paid ✓") — armed now,
      // revealed when the exit scan beam clears them at the fare-gate.
      if (u.result === 'pass' && u.imageURL) {
        armVerifyFlash(u.imageURL, roster.get(u.id)?.name, 'Paid ✓', u.id);
      }
    }));
    // shelf sub-machine: commanded walk-up, scan verdict, per-item picks, and
    // the API-side session end (walkAway command / 30s shelfClose timer)
    es.addEventListener('walkToShelf', fwd((u) => peopleRef.current?.walkToShelfUser?.(u.id, u.shelfId)));
    es.addEventListener('scanQR', fwd((u) => peopleRef.current?.scanQRUser?.(u.id, u.result)));
    es.addEventListener('inspectItem', fwd((u) => peopleRef.current?.inspectItemUser?.(u.id, u.result)));
    es.addEventListener('walkAway', fwd((u) => peopleRef.current?.walkAwayUser?.(u.id)));
    es.addEventListener('shelfClose', fwd((u) => peopleRef.current?.shelfCloseUser?.(u.id)));
    return () => { clearTimeout(syncT); es.close(); };
  }, []);

  // selected shelf (1–6) drives the stock filter; null = show all shelves.
  // Shelf and person focus are mutually exclusive: picking a shelf clears the
  // person; while a shelf is focused the scene refuses person picks entirely.
  const [selectedShelf, setSelectedShelf] = useState(null);
  const [selectedPerson, setSelectedPerson] = useState(null);
  // a click on a shelf toggles it; a click on empty floor (id == null) clears.
  const handleSelectShelf = useCallback((id) => {
    setSelectedShelf((prev) => (id == null ? null : prev === id ? null : id));
    if (id != null) setSelectedPerson(null);
  }, []);
  // a click on a shopper toggles them (only fires when no shelf is focused).
  const handleSelectPerson = useCallback((id) => {
    setSelectedPerson((prev) => (id == null ? null : prev === id ? null : id));
  }, []);
  // a click on a CUSTOMERS row also toggles, but overrides any shelf focus —
  // the list is an explicit target, unlike ambient picking in the 3D stage.
  const handleSelectPersonFromList = useCallback((id) => {
    setSelectedShelf(null);
    setSelectedPerson((prev) => (prev === id ? null : id));
  }, []);

  // live data for the followed person's card. Position never touches React —
  // the scene writes the wrapper's transform per frame; only text goes through
  // state, polled at 2 Hz. get() returning null means they despawned → close.
  const [personData, setPersonData] = useState(null);
  useEffect(() => {
    if (!selectedPerson) { setPersonData(null); return; }
    const read = () => {
      const d = peopleRef.current?.get?.(selectedPerson) ?? null;
      if (!d) setSelectedPerson(null);
      else setPersonData(d);
    };
    read();
    const t = setInterval(read, 500);
    return () => clearInterval(t);
  }, [selectedPerson]);
  const bindPersonCard = useCallback((el) => { peopleRef.current?.bindCard?.(el); }, []);

  // ---- live stock (seeded from GET /shelfs, then driven live by MQTT) ----
  // qty seeds from each device's real product.current_qty (0 when the feed omits
  // it); loadcell pick/return events then push the on-shelf currentQty through
  // /shelfs/events → the effect below. No simulation — the numbers are real.
  const [stock, setStock] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const stockRef = useRef(stock);
  stockRef.current = stock;

  useEffect(() => {
    if (!catalog) return;
    setStock(catalog.shelves.flatMap((sh) =>
      (sh.items ?? []).map((it) => ({ ...it, shelf: sh.id }))));
    // seed alerts derive from the same data: one per offline shelf, plus the
    // decorative temperature warning on the first online shelf
    const seeds = [];
    for (const sh of catalog.shelves) {
      if (!sh.online) seeds.push({ id: `a${alertSeq++}`, lvl: 'warn', title: 'Shelf Offline', sub: `${sh.name} (${shelfIdStr(sh.id)})`, time: '10:22 AM' });
    }
    const first = catalog.shelves.find((s) => s.online);
    if (first) seeds.push({ id: `a${alertSeq++}`, lvl: 'caution', title: 'Temperature Warning', sub: `${first.name} (${shelfIdStr(first.id)})`, time: '10:15 AM' });
    setAlerts(seeds);
  }, [catalog]);

  // shelf lock events from the scene: mirror the state map + drop a live
  // entry into the alert feed (info-level — scans are routine, not warnings).
  const handleShelfEvent = useCallback((ev) => {
    if (ev.type === 'unlocked') setShelfLockMap((m) => ({ ...m, [ev.shelfId]: 'open' }));
    else if (ev.type === 'relocked') setShelfLockMap((m) => ({ ...m, [ev.shelfId]: 'locked' }));
    const meta = LOCK_EVENT_META[ev.type];
    if (!meta) return;
    setAlerts((a) => [{
      id: `a${alertSeq++}`,
      ...meta,
      sub: `${shelfNameRef.current[ev.shelfId] ?? 'Shelf'} (${shelfIdStr(ev.shelfId)})`,
      time: fmtTime(new Date()),
    }, ...a].slice(0, 6));
  }, []);

  // shelf state feed (/shelfs/events, both MQTT-driven):
  //   online — flip the shelf live in the 3D scene (amber LED + locked doors ⇄
  //            scannable); deviceId is the shelf id (Shelf.id === device_id).
  //   stock  — a real pick/return changed the on-shelf qty: update that item and,
  //            when the status worsens (ok→low→out), drop one alert into the feed.
  useEffect(() => {
    const es = new EventSource(`${SHELFS_API_URL}/events`);
    es.addEventListener('online', (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (d && d.deviceId != null) sceneCtrlRef.current?.setShelfOnline?.(d.deviceId, !!d.online);
    });
    es.addEventListener('stock', (ev) => {
      let s;
      try { s = JSON.parse(ev.data); } catch { return; }
      if (!s || s.deviceId == null) return;
      const it = stockRef.current.find((x) => x.shelf === s.deviceId && x.id === s.sku);
      if (!it) return;
      if (statusRank[statusOf(s.qty, it.reorder)] > statusRank[statusOf(it.qty, it.reorder)]) {
        const after = statusOf(s.qty, it.reorder);
        setAlerts((a) => [{
          id: `a${alertSeq++}`,
          lvl: after === 'out' ? 'warn' : 'caution',
          title: after === 'out' ? 'Out of Stock' : 'Low Stock',
          sub: it.name,
          time: fmtTime(new Date()),
        }, ...a].slice(0, 6));
      }
      setStock((prev) => prev.map((x) =>
        (x.shelf === s.deviceId && x.id === s.sku ? { ...x, qty: s.qty } : x)));
    });
    return () => es.close();
  }, []);

  // Esc closes the inspector (mirrors the ✕ / click-empty / click-again paths).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { setSelectedShelf(null); setSelectedPerson(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // stock shown in the panel: all shelves, or just the selected one.
  const shownStock = selectedShelf ? stock.filter((s) => s.shelf === selectedShelf) : stock;

  // data for the floating shelf-detail card (V3-style summary, V4 content).
  const detail = selectedShelf
    ? {
        id: shelfIdStr(selectedShelf),
        name: shelfName[selectedShelf],
        online: !offlineShelves.has(selectedShelf),
        lock: locksLive ? shelfLockMap[selectedShelf] : null,
        items: stock.filter((s) => s.shelf === selectedShelf),
      }
    : null;

  const onlineCount = shelvesDef.filter((s) => s.online).length;
  const offlineCount = shelvesDef.length - onlineCount;

  // catalogue not in yet: the dashboard derives everything from it, so hold
  // the whole chrome behind the same boot overlay look; failures show a
  // retry instead of a spinner that never lands.
  if (loadError || !catalog) {
    return (
      <div className="dash">
        <div className="loading dash-loading">
          {loadError ? (
            <>
              <span style={{ fontSize: 26 }}>⚠</span>
              <span style={{ maxWidth: 480, textAlign: 'center' }}>
                Failed to load store data — {loadError}
              </span>
              <button
                onClick={loadCatalog}
                style={{
                  marginTop: 14, padding: '8px 22px', cursor: 'pointer',
                  background: 'transparent', color: '#35c3ff',
                  border: '1px solid #35c3ff', borderRadius: 6,
                  font: 'inherit', letterSpacing: '0.08em',
                }}
              >
                RETRY
              </button>
            </>
          ) : (
            <>
              <span className="boot-spinner" />
              Loading store data…
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="dash is-armed" ref={rootRef}>
      {/* boot overlay — same .loading chrome as V1–V3; the spinner animates on
          the compositor, so it keeps turning even while the scene build blocks
          the main thread. Stays mounted so the .hidden fade-out can play. */}
      {deferScene && (
        <div className={`loading dash-loading${booting ? '' : ' hidden'}`}>
          <span className="boot-spinner" />
          Initializing store…
        </div>
      )}
      {/* ===== header ===== */}
      <header className="dash-head">
        <div className="brand-block">
          <h1>SMART SHELF</h1>
          <span>INTELLIGENT RETAIL SOLUTION</span>
        </div>
        <nav className="dash-nav">
          {NAV.map((n, i) => (
            <button key={n} className={`nav-item${i === tab ? ' active' : ''}`} onClick={() => setTab(i)}>{n}</button>
          ))}
        </nav>
        <div className="head-right">
          <span className="status-dot"><i /> Connected</span>
          <span className="clock">10:42 AM</span>
          <div className="avatar" />
        </div>
      </header>

      <div className={`dash-body${leftCollapsed ? ' left-collapsed' : ''}${rightCollapsed ? ' right-collapsed' : ''}`}>
        {!booting && (
          <>
            <button
              className="sb-toggle sb-toggle-left"
              onClick={() => setLeftCollapsed((v) => !v)}
              title={leftCollapsed ? 'Show panel' : 'Hide panel'}
            >
              {leftCollapsed ? '›' : '‹'}
            </button>
            <button
              className="sb-toggle sb-toggle-right"
              onClick={() => setRightCollapsed((v) => !v)}
              title={rightCollapsed ? 'Show panel' : 'Hide panel'}
            >
              {rightCollapsed ? '‹' : '›'}
            </button>
          </>
        )}
        {/* ===== left column ===== */}
        <aside className="col col-left">
          <section className="card">
            <div className="card-head"><h2>STORE OVERVIEW</h2><span className="chev">›</span></div>
            {STAT_CARDS.map((s) => (
              <div className="stat" key={s.k}>
                <div className="stat-k">{s.k}</div>
                <div className="stat-v">{s.v}<small>{s.u}</small></div>
                <div className="stat-d up">{s.d} <em>vs yesterday</em></div>
                <Spark data={s.spark} color={s.color} />
              </div>
            ))}
          </section>

          {crowd && (
            <CustomersCard
              peopleRef={peopleRef}
              crowd={crowd.total}
              outsideUsers={outsideUsers}
              selectedPerson={selectedPerson}
              onSelect={handleSelectPersonFromList}
              shelfName={shelfName}
            />
          )}

          <section className="card">
            <div className="card-head"><h2>HEATMAP</h2><span className="pill">Today ▾</span></div>
            <Heatmap />
            <div className="heat-scale"><span>Low</span><div className="heat-bar" /><span>High</span></div>
          </section>

          <section className="card">
            <div className="card-head"><h2>ENVIRONMENT</h2></div>
            <div className="env-grid">
              {ENV.map((e) => (
                <div className="env" key={e[0]}>
                  <div className="env-k">{e[0]}</div>
                  <div className="env-v">{e[1]}<small>{e[2]}</small></div>
                  <div className="env-s ok">{e[3]}</div>
                </div>
              ))}
            </div>
          </section>
        </aside>

        {/* ===== center 3D ===== */}
        <main className="col col-center">
          <StoreStage
            selectedShelf={selectedShelf}
            selectedPerson={selectedPerson}
            onSelectShelf={handleSelectShelf}
            onSelectPerson={handleSelectPerson}
            onShelfEvent={handleShelfEvent}
            sceneFactory={sceneFactory}
            onController={handleController}
            defer={deferScene}
            onReady={handleReady}
            shelves={catalog.shelves}
            users={catalog.users}
          />
          {detail && <ShelfDetailCard detail={detail} onClose={() => setSelectedShelf(null)} />}
          {selectedPerson != null && personData && (
            <PersonDetailCard
              person={personData}
              onClose={() => setSelectedPerson(null)}
              bindEl={bindPersonCard}
              shelfName={shelfName}
            />
          )}
          {/* verify-pass image bubble — floats above the shopper's head (scene
              writes the follow transform onto the track); auto-fades after ~3s */}
          {verifyFlash && (
            <div className={`verify-flash-track${verifyFlashClosing ? ' closing' : ''}`} ref={bindVerifyFlash}>
              <div className="verify-flash-bubble">
                <img
                  className="verify-flash-img"
                  src={verifyFlash.imageURL}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={closeVerifyFlash}
                />
                <div className="verify-flash-cap">
                  {verifyFlash.name && <b>{verifyFlash.name}</b>}
                  <span className="verify-flash-ok">{verifyFlash.label}</span>
                </div>
              </div>
            </div>
          )}
          <div className="floor-ctrl">
            <span className="fc-label">FLOOR PLAN</span>
            <div className="seg">
              <button className={!view3d ? 'active' : ''} onClick={() => setView3d(false)}>2D</button>
              <button className={view3d ? 'active' : ''} onClick={() => setView3d(true)}>3D</button>
            </div>
            <div className="floors">
              {['Floor 1', 'Floor 2', 'Floor 3'].map((f, i) => (
                <button key={f} className={`floor-btn${i === floor ? ' active' : ''}`} onClick={() => setFloor(i)}>{f}</button>
              ))}
            </div>
            {crowd && (
              <>
                {/* read-only meters — random crowd is driven from the Backdoor,
                    API customers from the users API */}
                <div className="crowd-meter">
                  <span className="cm-chip random">RANDOM {crowd.total}<em>/{crowd.maxTotal}</em></span>
                  <span className="cm-chip api">API {crowd.api ?? 0}</span>
                </div>
                <span className="fc-label crowd-label">
                  WALKING {crowd.walking} · BROWSING {crowd.browsing}
                </span>
              </>
            )}
          </div>
        </main>

        {/* ===== right column ===== */}
        <aside className="col col-right">
          <section className="card">
            <div className="card-head"><h2>SHELF STATUS</h2><span className="chev">›</span></div>
            <div className="shelf-status">
              <Donut online={onlineCount} offline={offlineCount} />
              <div className="ss-legend">
                <div><span className="dot on" /> Online <b>{onlineCount}</b> <em>{Math.round((onlineCount / (shelvesDef.length || 1)) * 100)}%</em></div>
                <div><span className="dot off" /> Offline <b>{offlineCount}</b> <em>{Math.round((offlineCount / (shelvesDef.length || 1)) * 100)}%</em></div>
              </div>
            </div>
            <div className="shelf-sub">SHELF LIST</div>
            <ul className="shelf-list2">
              {shelvesDef.map((s) => (
                <li
                  key={s.id}
                  className={selectedShelf === s.id ? 'active' : ''}
                  style={{ cursor: 'pointer' }}
                  onClick={() => handleSelectShelf(s.id)}
                >
                  <span className="sl-id">{shelfIdStr(s.id)}</span> {s.name}
                  {locksLive && (
                    <span className={`sl-lock ${shelfLockMap[s.id]}`}>
                      {shelfLockMap[s.id] === 'open' ? 'OPEN' : shelfLockMap[s.id] === 'offline' ? 'N/A' : 'LOCKED'}
                    </span>
                  )}
                  <span className={`sl-state ${s.online ? 'on' : 'off'}`}>{s.online ? 'Online' : 'Offline'}</span>
                </li>
              ))}
            </ul>
            <a className="view-all">View all</a>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>LIVE STOCK</h2>
              {selectedShelf ? (
                <button className="stk-filter" onClick={() => setSelectedShelf(null)}>
                  {shelfIdStr(selectedShelf)} {shelfName[selectedShelf]}
                  <span className="stk-filter-x">×</span>
                </button>
              ) : (
                <span className="live-badge"><i />Live</span>
              )}
            </div>
            {selectedShelf && offlineShelves.has(selectedShelf) && (
              <div className="stk-offline">⚠ Shelf Offline · last known stock</div>
            )}
            <ul className="stock-list">
              {shownStock.length
                ? shownStock.map((it) => <StockRow key={`${it.shelf}-${it.id}`} item={it} />)
                : <li className="stk-empty">No items on this shelf</li>}
            </ul>
          </section>

          <section className="card">
            <div className="card-head"><h2>ALERTS</h2><a className="view-all sm">View all</a></div>
            <ul className="alerts">
              {alerts.map((al) => (
                <li key={al.id}>
                  <span className={`al-ico ${al.lvl}`}>{al.ico || '⚠'}</span>
                  <div className="al-body"><b>{al.title}</b><span>{al.sub}</span></div>
                  <span className="al-time">{al.time}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      {/* ===== bottom nav ===== */}
      <nav className="dash-bottom">
        {BOTTOM.map(([label, ico], i) => (
          <button key={label} className={`bn${i === 0 ? ' active' : ''}`}>
            <span className="bn-ico">{ico}</span><span>{label}</span>
          </button>
        ))}
      </nav>

    </div>
  );
}
