import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { Flip } from 'gsap/Flip';
import { createSmartStoreBabylonScene, validateShelfLayout, validateUsers } from '../scenes/smartStoreBabylon.js';
import BootSplash, { useBootProgress } from './BootSplash.jsx';
import { HeadCards, useHeadCards } from './HeadCards.jsx';
import { NameTags, useNameTagMode } from './NameTags.jsx';
import PersonAvatar from './PersonAvatar.jsx';
import { apiFetch } from '../api';

gsap.registerPlugin(Flip);

/* ---------- tiny presentational helpers ---------- */

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

const NAV =['STORE OVERVIEW', 'SHELF STATUS', 'ANALYTICS', 'ALERTS'];
const BOTTOM = [
  ['Dashboard', '⌂'], ['Analytics', '📊'], ['Products', '🛍'], ['Alerts', '🔔'], ['Settings', '⚙'],
];
// Bottom nav is mockup chrome — none of the five buttons has a handler. Off by
// default; flip to `true` to get it back untouched (its CSS, the `.is-armed`
// pre-hide rule and the GSAP entrance target all stay in place for that).
const SHOW_BOTTOM_NAV = false;

/* ---------- 3D center stage mount ---------- */
// `sceneFactory(container, { onSelectShelf }) => { dispose, selectShelf }` lets
// V4 (Three.js) and V5 (Babylon.js) share the exact same dashboard chrome —
// only the engine driving the center stage differs.
function StoreStage({ selectedShelf, selectedPerson, onSelectShelf, onSelectPerson, onFollowPerson, onShelfEvent, sceneFactory, onController, defer = false, onReady, onProgress, shelves, users }) {
  const ref = useRef(null);
  const ctrlRef = useRef(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let controller = null;
    const create = () => {
      if (controller) return; // double-rAF and the timeout fallback can race
      controller = { dispose() {}, selectShelf() {} };
      try { controller = sceneFactory(container, { onSelectShelf, onSelectPerson, onFollowPerson, onReady, onProgress, onShelfEvent, shelves, users }); }
      catch (e) { console.error('[storeStage] scene factory failed:', e); onReady?.(); }
      ctrlRef.current = controller;
      onController?.(controller);
    };
    // arms the splash's creep across the build. Must be committed and PAINTED
    // before create() runs, or the target lands with the main thread already
    // wedged and the bar sits still through the whole build. Guarded like
    // create(): the rAF pair and the timeout fallback both call it, and a second
    // arming after the build is done would re-creep a phase already paid for.
    let armed = false;
    const armBuild = () => {
      if (armed || controller) return;
      armed = true;
      onProgress?.({ phase: 'build' });
    };
    let raf1 = 0, raf2 = 0, fallback = 0;
    if (!defer) {
      // Create directly — the container already has its committed layout size in
      // the effect, so we don't need to defer a frame (and some headless
      // environments throttle rAF, which would stall the deferred create).
      armBuild();
      create();
    } else {
      // V5's synchronous scene build blocks the main thread for seconds — let
      // the browser paint the boot overlay first. Double rAF guarantees one
      // painted frame before the blocking work; the timeout is the safety net
      // for throttled/background tabs where rAF may take ~1s per tick.
      raf1 = requestAnimationFrame(() => { armBuild(); raf2 = requestAnimationFrame(create); });
      fallback = setTimeout(() => { armBuild(); create(); }, 500);
    }
    return () => {
      cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); clearTimeout(fallback);
      controller?.dispose(); ctrlRef.current = null; onController?.(null);
    };
    // created once; selection flows in via the sync effects below.
  }, [onSelectShelf, onSelectPerson, onFollowPerson, onShelfEvent, sceneFactory, onController, defer, onReady, onProgress, shelves, users]);

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

  // The product photo leads the row, and there is no stand-in: all three ways of
  // having no picture — no product, an empty image_url, a URL that fails to load
  // — draw nothing at all, and the row starts at its text. Keyed reset: a row
  // whose image once failed must try again when the shelf's product changes (the
  // stock list is reseeded on every catalog load).
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => { setImgFailed(false); }, [item.image]);
  const showImg = !!item.image && !imgFailed;

  const status = statusOf(item.qty, item.reorder);
  const pct = Math.max(0, Math.min(100, (item.qty / item.capacity) * 100));
  return (
    <li className={`stk-row${flash ? ' flash' : ''}`}>
      {showImg && (
        <img
          className="stk-thumb"
          src={item.image}
          alt=""
          loading="lazy"
          decoding="async"
          width="28"
          height="28"
          onError={() => setImgFailed(true)}
        />
      )}
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
// "In store" counts from the API's `entered_at`, which for the crowd already
// inside at boot can be hours or days back — flat minutes would read
// "14520m 00s". Roll up to h/d and drop the unit that's become noise.
const fmtDur = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor(s / 60) % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
};

// closeTitle is a prop because ✕ stops meaning "close" during Focus mode — there
// it only hides the card, and Esc (which still clears everything) is no longer
// the same key stroke.
function PersonDetailCard({ person, onClose, closeTitle, bindEl, shelfName }) {
  return (
    <div className="person-card-track" ref={bindEl}>
      <div className="store-detail-card person-card">
        <button className="detail-close" onClick={onClose} title={closeTitle}>✕</button>
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

function CustomersCard({ peopleRef, crowd, outsideUsers, selectedPerson, onSelect, followedPerson, onFollow, shelfName }) {
  const [list, setList] = useState([]);
  const ulRef = useRef(null);
  const flipState = useRef(null);

  // right-click menu — Focus mode's only entry point. Anchored to the pointer
  // and portalled out, not mounted inside the row: the list re-sorts every
  // second with a FLIP animation, so a row-anchored menu would slide away
  // mid-aim. Exited rows have no 3D body to follow and keep the native menu.
  const [menu, setMenu] = useState(null); // { id, x, y } | null
  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = useCallback((id, e) => {
    e.preventDefault();
    // keep it on screen when the row sits near the bottom edge (menu ≈ 46px tall)
    setMenu({
      id,
      x: Math.min(e.clientX, window.innerWidth - 184),
      y: Math.min(e.clientY, window.innerHeight - 58),
    });
  }, []);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
    // capture, so a scroll inside the list (which doesn't bubble) still closes it
    window.addEventListener('pointerdown', closeMenu);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', closeMenu);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('resize', closeMenu);
    };
  }, [menu, closeMenu]);
  // they can despawn while the menu sits open — don't leave a menu pointing at
  // a shopper who has already walked out
  useEffect(() => {
    if (menu && !list.some((p) => p.id === menu.id)) closeMenu();
  }, [list, menu, closeMenu]);

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
                className={`cust-row${selectedPerson === p.id ? ' active' : ''}${followedPerson === p.id ? ' following' : ''}`}
                onClick={() => onSelect(p.id)}
                onContextMenu={(e) => openMenu(p.id, e)}
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
                    {followedPerson === p.id && <span className="cust-follow" title="Camera is following">🎥</span>}
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
      {menu
        ? createPortal(
            // same portal reasoning as the tooltip. onPointerDown stops the
            // window-level dismissal from firing before the click lands.
            <div
              className="cust-menu"
              role="menu"
              style={{ left: menu.x, top: menu.y }}
              onPointerDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                className="cust-menu-item"
                role="menuitem"
                onClick={() => { onFollow(menu.id); closeMenu(); }}
              >
                🎥 {followedPerson === menu.id ? 'Exit focus mode' : 'Focus mode'}
              </button>
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
  // sidebar collapse — independent, visual-only (CSS hide, no unmount) so
  // polling underneath keeps running and a re-open shows live data. Not
  // persisted: every load starts with both panels open.
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  // NAME TAGS mode — a pill over every head at once (bottom bar). Persisted, so
  // unlike the two above this one does survive a reload; see useNameTagMode.
  const [nameTags, setNameTags] = useNameTagMode();

  // ---- mock data (shelf catalogue + customer roster): fetched, validated,
  // then everything derives ----
  const [catalog, setCatalog] = useState(null);   // { shelves: [...], users: [...] } once loaded
  const [loadError, setLoadError] = useState(null);
  // boot splash: one continuous 0→100% screen over the fetch, the scene build
  // and the character preload. It owns the % — the scene only reports milestones.
  const boot = useBootProgress(true);
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
        boot.mark('data');
        setCatalog({ shelves: shelfData, users: userData });
      })
      .catch((e) => { setLoadError(String(e?.message || e)); boot.fail(e?.message || e); });
    // boot.mark/fail are stable — no reason to re-arm the fetch on a re-render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  const retryCatalog = useCallback(() => { boot.reset(); loadCatalog(); }, [boot, loadCatalog]);

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
  // sku → what the head card needs to say about the product: the scanQR event
  // carries only the sku, and item.id IS the sku (see toShelf on the API side).
  // One entry per sku rather than a map per field, so a card that later wants
  // another product detail doesn't need a third parallel lookup.
  const skuInfo = useMemo(
    () => Object.fromEntries(shelvesDef.flatMap((s) =>
      (s.items ?? []).map((it) => [it.id, { name: it.name, image: it.image }]))),
    [shelvesDef]);
  const skuInfoRef = useRef({});
  skuInfoRef.current = skuInfo;
  const lockInitRef = useRef(lockInit);
  lockInitRef.current = lockInit;

  // Boot splash: covers the dash from the first paint until the scene is live
  // AND populated, so the heavy synchronous build never shows as a frozen
  // half-drawn dashboard. The scene signals readiness via onReady; the splash
  // then lands the bar on 100% and fades itself out.
  const booting = boot.visible;
  const handleReady = boot.ready;

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
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (typeof d?.target === 'number') peopleRef.current?.setCrowdTarget?.(d.target);
      // same event carries the Costume Mode switch (wardrobe, not head-count)
      if (typeof d?.costume === 'boolean') peopleRef.current?.setCostumeMode?.(d.costume);
    });
    return () => es.close();
  }, []);
  // scan-verdict / browse cards above API customers' heads. Armed from the two
  // feeds below, revealed by the scene when the causing gesture ends — see
  // HeadCards.jsx for why the reveal is not ours to make, and why the browse
  // card's DEATH is not ours either. Both arms are stable, so the SSE effects
  // that depend on them never re-subscribe.
  const { cards: headCards, armScan, armPickReturn } = useHeadCards(peopleRef);

  // shelf-scan sessions feed — the SINGLE source of pick/return in the scene.
  // Both the MQTT loadcell and a commanded `inspectItem` land here (the API
  // routes the command through the session basket so the mock path and the
  // hardware path are one path), which is why the users feed's own
  // `inspectItem` event no longer drives anything: it would double the gesture.
  // Each event plays the gesture (userId → 3D body) and rewrites the browse card
  // already floating over them, which the scene reveals when that gesture ends.
  // Every number on the card comes off `s.summary` — the API's single tally for
  // the shelf visit — so nothing here counts anything.
  useEffect(() => {
    const es = new EventSource(`${SESSIONS_API_URL}/events`);
    const gesture = (result) => (ev) => {
      let s;
      try { s = JSON.parse(ev.data); } catch { return; }
      // userId is User.id — a uuid string since the id split (it used to be a
      // number, and guarding on `typeof === 'number'` silently swallowed every
      // pick and return)
      if (!s || typeof s.userId !== 'string' || !s.userId || !s.summary) return;
      peopleRef.current?.inspectItemUser?.(s.userId, result);
      armPickReturn(s.userId, s);
    };
    es.addEventListener('picked', gesture('keep'));
    es.addEventListener('returned', gesture('return'));
    return () => es.close();
  }, [armPickReturn]);
  // pull the current target once the scene is ready so it matches the API
  useEffect(() => {
    if (!crowd) return;
    apiFetch(CROWD_API_URL)
      .then((d) => {
        if (!d) return;
        peopleRef.current?.setCrowdTarget?.(d.target);
        if (d.costume) peopleRef.current?.setCostumeMode?.(true); // survives a page reload
      })
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
  // `roster` is the odd one out: a whole-store replace (see its listener below).
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
    // Newest movement first. This list is where externally-registered customers
    // pile up waiting to be verified, so a fresh arrival has to be visible
    // without scrolling past everyone who ever left. `updated_at` and not the
    // id: ids are uuids and carry no order, and it also puts someone who just
    // paid and walked out at the top, which reading by id never could.
    const publish = () =>
      setOutsideUsers(
        [...roster.values()]
          .filter((u) => u.status === 'outside')
          .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''))),
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
    // roster refresh (Backdoor's "Reload from External"): one event carrying the
    // whole store, not a per-user delta — `fwd` can't touch it. The mirror is
    // replaced outright and the scene rebuilds every API body from the array.
    // Deliberately NOT hung off `open` as well: a reconnect is silent and
    // frequent (dev restarts, sleep, hot reload) and this is destructive.
    es.addEventListener('roster', (ev) => {
      let list;
      try { list = JSON.parse(ev.data); } catch { return; }
      if (!Array.isArray(list)) return;
      roster.clear();
      for (const u of list) roster.set(u.id, u);
      publish();
      peopleRef.current?.reseedUsers?.(list);
      // every body on the floor is a new one, so nothing that pointed at a body
      // survives: drop the follow, the selection and any armed face bubble
      setFollowedPerson(null);
      setSelectedPerson(null);
      setCardHidden(false);
      closeVerifyFlash();
    });
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
    es.addEventListener('scanQR', fwd((u) => {
      peopleRef.current?.scanQRUser?.(u.id, u.result);
      // revealed by the scene once the phone comes back down — the scanning tag
      // owns that spot above their head until then. A pass OPENS the browse card
      // that stays up for the whole shelf visit; a fail is a 2s flash.
      armScan(u.id, u.result, u.sku, skuInfoRef.current[u.sku]);
    }));
    // `inspectItem` is a command only. Its effect reaches the scene through the
    // sessions feed above (the API moves an item on the shopper's shelf session,
    // which emits picked/returned); listening here too would play it twice.
    es.addEventListener('walkAway', fwd((u) => peopleRef.current?.walkAwayUser?.(u.id)));
    es.addEventListener('shelfClose', fwd((u) => peopleRef.current?.shelfCloseUser?.(u.id)));
    return () => { clearTimeout(syncT); es.close(); };
  }, [armScan, closeVerifyFlash]);

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

  // ---- Focus mode: the camera pans along with one shopper until something
  // takes the camera back. Selection and follow are deliberately different
  // things — a left-click on a row only selects; only the row's right-click
  // menu starts a follow — but a follow always implies a selection, which is
  // where the pulsing ring and the floating card come from for free.
  const [followedPerson, setFollowedPerson] = useState(null);
  const toggleFollow = useCallback((id) => {
    setFollowedPerson((prev) => {
      const next = prev === id ? null : id;
      if (next != null) {
        setSelectedShelf(null); // exclusive camera owners (scene enforces it too)
        setSelectedPerson(next);
        setFloor(0);            // a Floor-2 deck would sit right on top of them
      }
      return next;
    });
  }, []);
  // The mode can't outlive its selection: Esc, a click on empty floor, picking
  // another row, focusing a shelf and the despawn watchdog all clear
  // `selectedPerson`, so this one rule covers every exit the scene doesn't own.
  useEffect(() => {
    if (followedPerson != null && selectedPerson !== followedPerson) setFollowedPerson(null);
  }, [selectedPerson, followedPerson]);
  // scene-side exits (it despawned them, or a shelf/floor hand-off took over)
  const handleFollowPerson = useCallback((id) => { setFollowedPerson(id ?? null); }, []);
  // ---- the card can be folded away without ending the mode. The invariant is
  // `cardHidden ⊆ following`: hiding is only reachable while the chip is on
  // screen, and the chip is the only way back, so a hidden card must never
  // outlive it — entering or leaving the mode, and switching subject, all
  // unfold it again. Without this you get a shopper with a glowing ring, no
  // card, no chip, and nothing on screen to click.
  const [cardHidden, setCardHidden] = useState(false);
  useEffect(() => { setCardHidden(false); }, [selectedPerson, followedPerson]);
  // ✕ on the card is context-dependent: clearing the selection would drag Focus
  // mode down with it (the rule above), so while following it only folds the
  // card away. Outside the mode it still closes the inspector outright.
  const closePersonCard = useCallback(() => {
    if (followedPerson != null) setCardHidden(true);
    else setSelectedPerson(null);
  }, [followedPerson]);
  // Pushed into the scene LAST on purpose. One commit can move the camera three
  // times (shelf focus clearing, Floor 2 collapsing, then this) through a single
  // shared fly tween — going last lets the follow read the others' flight
  // *destination* as the framing it must give back, instead of a mid-air pose.
  // Effects run in declaration order, and this sits below the floor sync above;
  // putting it in StoreStage would run it first, since child effects go first.
  useEffect(() => { peopleRef.current?.follow?.(followedPerson); }, [followedPerson]);

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
  // The scene fades the card out for the whole time its shopper stands at a
  // shelf — the scan tag and the pick/return pills need that space above their
  // head. It decides that per frame off `mode === 'browse'`; React only mirrors
  // it so the chip stops claiming a card is on screen. These two statuses come
  // out of that same branch of getPersonData, so the 2 Hz poll costs an
  // indicator half a second of lag and nothing else — the fade stays exact.
  const cardAtShelf = personData?.status === 'scanning' || personData?.status === 'browsing';

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
  // Clearing the person also ends Focus mode, via the effect that ties the two.
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

  // catalogue not in yet: the dashboard derives everything from it, so hold the
  // chrome back and let the splash carry the wait. Same root element type with
  // the splash as its first child in BOTH branches — React then reconciles the
  // splash in place instead of remounting it, which would rewind the bar to 0
  // at the exact moment the data lands.
  if (loadError || !catalog) {
    return (
      <div className="dash" ref={rootRef}>
        <BootSplash boot={boot} onRetry={retryCatalog} />
      </div>
    );
  }

  return (
    <div className="dash is-armed" ref={rootRef}>
      {/* stays mounted after 100% so the .hidden fade-out can play */}
      <BootSplash boot={boot} onRetry={retryCatalog} />
      {/* ===== header ===== */}
      <header className="dash-head">
        <div className="brand-block">
          <h1>ATK STORE</h1>
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
        {/* ===== left column — CUSTOMERS only ===== */}
        <aside className="col col-left">
          {crowd && (
            <CustomersCard
              peopleRef={peopleRef}
              crowd={crowd.total}
              outsideUsers={outsideUsers}
              selectedPerson={selectedPerson}
              onSelect={handleSelectPersonFromList}
              followedPerson={followedPerson}
              onFollow={toggleFollow}
              shelfName={shelfName}
            />
          )}
        </aside>

        {/* ===== center 3D ===== */}
        <main className="col col-center">
          <StoreStage
            selectedShelf={selectedShelf}
            selectedPerson={selectedPerson}
            onSelectShelf={handleSelectShelf}
            onSelectPerson={handleSelectPerson}
            onFollowPerson={handleFollowPerson}
            onShelfEvent={handleShelfEvent}
            sceneFactory={sceneFactory}
            onController={handleController}
            defer={deferScene}
            onReady={handleReady}
            onProgress={boot.mark}
            shelves={catalog.shelves}
            users={catalog.users}
          />
          {detail && <ShelfDetailCard detail={detail} onClose={() => setSelectedShelf(null)} />}
          {/* folded away = really unmounted, not display:none — the scene sizes
              the head-card stack off this element's offsetHeight and falls back
              to a 150px guess when it reads 0, which would float the event cards
              a card's height above an empty patch of air. Unmounting hands the
              scene a null through bindCard, the same path a despawn takes. */}
          {selectedPerson != null && personData && !cardHidden && (
            <PersonDetailCard
              person={personData}
              onClose={closePersonCard}
              closeTitle={followedPerson != null ? 'Hide card (keep following)' : 'Close (Esc)'}
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
          {/* scan-verdict / pick / return cards — same head-projection track as
              the bubble above, one per API customer, scene-revealed */}
          <HeadCards cards={headCards} peopleRef={peopleRef} />
          {/* NAME TAGS mode — a pill per body, on the same head projection as
              everything above. Mounted only while the mode is on, so its roster
              poll costs nothing when it's off. */}
          {nameTags && <NameTags peopleRef={peopleRef} />}
          {/* Focus mode banner — the only exit that survives both panels being
              collapsed, which is exactly what someone watching a followed
              shopper full-bleed will do. Top-center clears both floating panels. */}
          {followedPerson != null && personData && (
            <div className="follow-chip">
              {/* the label half doubles as the card's fold/unfold switch — a
                  real button so it takes keyboard focus; the caret is the only
                  thing on screen reporting that a card is folded away */}
              <button
                className="fchip-toggle"
                onClick={() => setCardHidden((v) => !v)}
                disabled={cardAtShelf}
                title={cardAtShelf
                  ? 'Card hidden while they are at the shelf'
                  : cardHidden ? 'Show detail card' : 'Hide detail card'}
              >
                <span className="fchip-eye">🎥</span>
                <span className="fchip-label">Following</span>
                <b className="fchip-name">{personData.name}</b>
                <span className="fchip-caret">{cardHidden || cardAtShelf ? '▸' : '▾'}</span>
              </button>
              <button
                className="fchip-close"
                onClick={() => setFollowedPerson(null)}
                title="Exit focus mode (Esc)"
              >✕</button>
            </div>
          )}
          <div className="floor-ctrl">
            <span className="fc-label">FLOOR PLAN</span>
            <div className="floors">
              {['Floor 1', 'Floor 2', 'Floor 3'].map((f, i) => (
                <button key={f} className={`floor-btn${i === floor ? ' active' : ''}`} onClick={() => setFloor(i)}>{f}</button>
              ))}
            </div>
            {/* Kept with the controls rather than out by the crowd meters: this
                bar splits into controls-then-readouts, and it `flex-wrap`s — a
                switch parked after the meters would break to its own row away
                from the buttons it belongs with on a narrow window.
                Label + segment, the shape the retired 2D/3D control used: the
                caption says what is being switched so the two buttons don't have
                to repeat it, and it reads as a pair with FLOOR PLAN's group. */}
            <span className="fc-label">NAME TAGS</span>
            <div className="seg">
              <button
                className={nameTags ? 'active' : ''}
                onClick={() => setNameTags(true)}
                title="Show a name tag over every shopper"
              >ON</button>
              <button
                className={!nameTags ? 'active' : ''}
                onClick={() => setNameTags(false)}
                title="Hide the name tags"
              >OFF</button>
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
      {SHOW_BOTTOM_NAV && (
        <nav className="dash-bottom">
          {BOTTOM.map(([label, ico], i) => (
            <button key={label} className={`bn${i === 0 ? ' active' : ''}`}>
              <span className="bn-ico">{ico}</span><span>{label}</span>
            </button>
          ))}
        </nav>
      )}

    </div>
  );
}
