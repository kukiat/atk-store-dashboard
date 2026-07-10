import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { Flip } from 'gsap/Flip';
import { createSmartStoreScene } from '../scenes/smartStore.js';

gsap.registerPlugin(Flip);

/* ---------- tiny presentational helpers ---------- */

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

const SHELVES = [
  ['01', 'Beverage Zone', true], ['02', 'Center Shelf A', true], ['03', 'Snacks Zone', true],
  ['04', 'Dairy & Juice', true], ['05', 'Fresh & Ready', false], ['06', 'Checkout Shelf', true],
];

// shelf id (1-based, matching the 3D zones) → display name + offline set, both
// derived from SHELVES so there is a single source of truth.
const SHELF_NAME = Object.fromEntries(SHELVES.map(([, name], i) => [i + 1, name]));
const OFFLINE_SHELVES = new Set(
  SHELVES.map(([, , on], i) => (on ? null : i + 1)).filter(Boolean)
);

// shelf lock mirror (V5): the scene owns the state and streams transitions up
// via onShelfEvent; this map only drives the UI chips. Offline shelves can't
// unlock — mirrors the scene's amber-LED rule.
const LOCK_INIT = Object.fromEntries(
  SHELVES.map(([, , on], i) => [i + 1, on ? 'locked' : 'offline'])
);
const LOCK_LABEL = { locked: 'Locked', open: 'Open', offline: 'Offline' };
const LOCK_EVENT_META = {
  unlocked: { lvl: 'ok', title: 'Shelf Unlocked', ico: '🔓' },
  relocked: { lvl: 'info', title: 'Shelf Re-locked', ico: '🔒' },
  scan_ok: { lvl: 'ok', title: 'Access Granted', ico: '📱' },
};

// Live-stock catalogue. `shelf` (1–6) maps to the zones in smartStore.js / the
// SHELF LIST below. `qty` / `reorder` are derived at init from `capacity`.
const STOCK_CATALOGUE = [
  { id: 'water',  name: 'Mineral Water',   shelf: 1, color: '#5b8def', capacity: 240 },
  { id: 'gtea',   name: 'Green Tea',        shelf: 1, color: '#4caf72', capacity: 180 },
  { id: 'cola',   name: 'Cola',             shelf: 1, color: '#e2574c', capacity: 200 },
  { id: 'noodle', name: 'Instant Noodles',  shelf: 2, color: '#e8a33d', capacity: 160 },
  { id: 'choco',  name: 'Chocolate Bar',    shelf: 2, color: '#b07cdb', capacity: 140 },
  { id: 'chips',  name: 'Potato Chips',     shelf: 3, color: '#efb23a', capacity: 120 },
  { id: 'pretz',  name: 'Pretzels',         shelf: 3, color: '#d9a05b', capacity: 110 },
  { id: 'ojuice', name: 'Orange Juice',     shelf: 4, color: '#f08a3c', capacity: 150 },
  { id: 'milk',   name: 'Fresh Milk',       shelf: 4, color: '#dfe6f2', capacity: 90  },
  { id: 'yogurt', name: 'Yogurt Cup',       shelf: 4, color: '#37c2c9', capacity: 100 },
  { id: 'sand',   name: 'Sandwich',         shelf: 5, color: '#e07baf', capacity: 60  },
  { id: 'salad',  name: 'Garden Salad',     shelf: 5, color: '#6fcf6f', capacity: 50  },
  { id: 'gum',    name: 'Chewing Gum',      shelf: 6, color: '#7ed0c3', capacity: 80  },
  { id: 'energy', name: 'Energy Drink',     shelf: 6, color: '#e2574c', capacity: 90  },
];

// stock level → status; `rank` orders them so we only alert when it gets worse.
const statusOf = (qty, reorder) => (qty <= 0 ? 'out' : qty <= reorder ? 'low' : 'ok');
const statusRank = { ok: 0, low: 1, out: 2 };
const statusLabel = { ok: 'OK', low: 'Low', out: 'Out' };

const initStock = () =>
  STOCK_CATALOGUE.map((p) => {
    const reorder = Math.round(p.capacity * 0.25);
    const qty = Math.round(p.capacity * (0.5 + Math.random() * 0.5)); // start 50–100% full
    return { ...p, reorder, qty };
  });

const fmtTime = (d) =>
  d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// seed alerts: keep the non-stock ones; stock alerts flow in live from the sim.
let alertSeq = 0;
const SEED_ALERTS = [
  { id: `a${alertSeq++}`, lvl: 'warn', title: 'Shelf Offline', sub: 'Fresh & Ready (05)', time: '10:22 AM' },
  { id: `a${alertSeq++}`, lvl: 'caution', title: 'Temperature Warning', sub: 'Beverage Zone (01)', time: '10:15 AM' },
];

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
function StoreStage({ selectedShelf, selectedPerson, onSelectShelf, onSelectPerson, onShelfEvent, sceneFactory, onController, defer = false, onReady }) {
  const ref = useRef(null);
  const ctrlRef = useRef(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let controller = null;
    const create = () => {
      if (controller) return; // double-rAF and the timeout fallback can race
      controller = { dispose() {}, selectShelf() {} };
      try { controller = sceneFactory(container, { onSelectShelf, onSelectPerson, onReady, onShelfEvent }); }
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
  }, [onSelectShelf, onSelectPerson, onShelfEvent, sceneFactory, onController, defer, onReady]);

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

function PersonDetailCard({ person, onClose, bindEl }) {
  return (
    <div className="person-card-track" ref={bindEl}>
      <div className="store-detail-card person-card">
        <button className="detail-close" onClick={onClose} title="Close (Esc)">✕</button>
        <div className="detail-head pc-head">
          <span className="pc-avatar" style={{ background: person.color }}>{person.initials}</span>
          <span className="pc-id">
            <span className="detail-title">{person.name}</span>
            <span className="pc-cust">CUSTOMER {person.custNo}</span>
          </span>
        </div>
        <dl className="detail-rows">
          <dt>Status</dt><dd>{PERSON_STATUS[person.status]}</dd>
          <dt>Near</dt><dd>{SHELF_NAME[person.near]} ({String(person.near).padStart(2, '0')})</dd>
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

function CustomersCard({ peopleRef, crowd, selectedPerson, onSelect }) {
  const [list, setList] = useState([]);
  const ulRef = useRef(null);
  const flipState = useRef(null);

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

  return (
    <section className="card">
      <div className="card-head">
        <h2>CUSTOMERS</h2>
        <span className="pill">{list.length} in store</span>
      </div>
      <ul className="cust-list" ref={ulRef}>
        {list.length ? (
          list.map((p) => (
            <li
              key={p.id}
              data-flip-id={`cust-${p.id}`}
              className={`cust-row${selectedPerson === p.id ? ' active' : ''}`}
              onClick={() => onSelect(p.id)}
            >
              <span className="pc-avatar cust-avatar" style={{ background: p.color }}>{p.initials}</span>
              <div className="cust-main">
                <div className="cust-top">
                  <span className="cust-name">{p.name}</span>
                  <span className={`cust-pill ${p.status}`}>{PERSON_STATUS[p.status]}</span>
                </div>
                <div className="cust-sub">
                  {SHELF_NAME[p.near]} ({String(p.near).padStart(2, '0')}) · {fmtDur(p.inStoreSec)}
                </div>
              </div>
            </li>
          ))
        ) : (
          <li className="stk-empty">No customers in store</li>
        )}
      </ul>
    </section>
  );
}

/* ---------- main dashboard ---------- */
export default function Dashboard({ sceneFactory = createSmartStoreScene, deferScene = false }) {
  const rootRef = useRef(null);
  const [tab, setTab] = useState(0);
  const [floor, setFloor] = useState(0);
  const [view3d, setView3d] = useState(true);

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
    if (booting) return;
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
  }, { scope: rootRef, dependencies: [booting] });

  // crowd stepper — only rendered when the scene exposes a `people` API (V5).
  const peopleRef = useRef(null);
  const [crowd, setCrowd] = useState(null); // { total, walking, browsing, maxTotal } or null

  // shelf lock mirror — see LOCK_INIT; scene → onShelfEvent → here.
  const [locksLive, setLocksLive] = useState(false);
  const [shelfLockMap, setShelfLockMap] = useState(LOCK_INIT);
  const handleController = useCallback((ctrl) => {
    peopleRef.current = ctrl?.people ?? null;
    setCrowd(ctrl?.people ? { ...ctrl.people.counts(), maxTotal: ctrl.people.maxTotal } : null);
    // lock UI only renders when the scene actually simulates locks (V5)
    setLocksLive(!!ctrl?.locks);
    setShelfLockMap(ctrl?.locks
      ? Object.fromEntries(ctrl.locks.states().map((s) => [s.id, s.state]))
      : LOCK_INIT);
  }, []);
  const changeCrowd = useCallback((delta) => {
    const api = peopleRef.current;
    if (!api) return;
    const total = delta > 0 ? api.add() : api.remove();
    setCrowd((c) => ({ ...c, total }));
  }, []);
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

  // ---- live stock simulation (client-side, ~5s tick) ----
  const [stock, setStock] = useState(initStock);
  const [alerts, setAlerts] = useState(SEED_ALERTS);
  const stockRef = useRef(stock);
  stockRef.current = stock;

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
      sub: `${SHELF_NAME[ev.shelfId]} (${String(ev.shelfId).padStart(2, '0')})`,
      time: fmtTime(new Date()),
    }, ...a].slice(0, 6));
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const newAlerts = [];
      const next = stockRef.current.map((it) => {
        if (OFFLINE_SHELVES.has(it.shelf)) return it;   // offline shelf → frozen, no tick
        const before = statusOf(it.qty, it.reorder);
        let qty = Math.max(0, it.qty - (1 + Math.floor(Math.random() * 8))); // sales drain
        if (qty <= it.reorder && Math.random() < 0.3) {
          qty = it.capacity;                                                 // urgent restock
        } else if (Math.random() < 0.05) {
          qty = Math.min(it.capacity, qty + Math.round(it.capacity * 0.3));  // routine delivery
        }
        const after = statusOf(qty, it.reorder);
        if (statusRank[after] > statusRank[before]) {                        // only when it gets worse
          newAlerts.push({
            id: `a${alertSeq++}`,
            lvl: after === 'out' ? 'warn' : 'caution',
            title: after === 'out' ? 'Out of Stock' : 'Low Stock',
            sub: it.name,
            time: fmtTime(new Date()),
          });
        }
        return { ...it, qty };
      });
      setStock(next);
      if (newAlerts.length) setAlerts((a) => [...newAlerts, ...a].slice(0, 6));
    }, 5000);
    return () => clearInterval(id);
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
        id: String(selectedShelf).padStart(2, '0'),
        name: SHELF_NAME[selectedShelf],
        online: !OFFLINE_SHELVES.has(selectedShelf),
        lock: locksLive ? shelfLockMap[selectedShelf] : null,
        items: stock.filter((s) => s.shelf === selectedShelf),
      }
    : null;

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

      <div className="dash-body">
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
              selectedPerson={selectedPerson}
              onSelect={handleSelectPersonFromList}
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
          />
          {detail && <ShelfDetailCard detail={detail} onClose={() => setSelectedShelf(null)} />}
          {selectedPerson != null && personData && (
            <PersonDetailCard
              person={personData}
              onClose={() => setSelectedPerson(null)}
              bindEl={bindPersonCard}
            />
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
                <div className="crowd-stepper">
                  <span className="cs-name">PEOPLE</span>
                  <button onClick={() => changeCrowd(-1)} disabled={crowd.total <= 0}>−</button>
                  <span className="cs-count">{crowd.total}</span>
                  <button onClick={() => changeCrowd(+1)} disabled={crowd.total >= crowd.maxTotal}>+</button>
                </div>
                {/* live mix — read-only: the shoppers decide when to browse */}
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
              <Donut online={28} offline={2} />
              <div className="ss-legend">
                <div><span className="dot on" /> Online <b>28</b> <em>93%</em></div>
                <div><span className="dot off" /> Offline <b>2</b> <em>7%</em></div>
              </div>
            </div>
            <div className="shelf-sub">SHELF LIST</div>
            <ul className="shelf-list2">
              {SHELVES.map(([id, name, on], i) => (
                <li
                  key={id}
                  className={selectedShelf === i + 1 ? 'active' : ''}
                  style={{ cursor: 'pointer' }}
                  onClick={() => handleSelectShelf(i + 1)}
                >
                  <span className="sl-id">{id}</span> {name}
                  {locksLive && (
                    <span className={`sl-lock ${shelfLockMap[i + 1]}`}>
                      {shelfLockMap[i + 1] === 'open' ? 'OPEN' : shelfLockMap[i + 1] === 'offline' ? 'N/A' : 'LOCKED'}
                    </span>
                  )}
                  <span className={`sl-state ${on ? 'on' : 'off'}`}>{on ? 'Online' : 'Offline'}</span>
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
                  {String(selectedShelf).padStart(2, '0')} {SHELF_NAME[selectedShelf]}
                  <span className="stk-filter-x">×</span>
                </button>
              ) : (
                <span className="live-badge"><i />Live</span>
              )}
            </div>
            {selectedShelf && OFFLINE_SHELVES.has(selectedShelf) && (
              <div className="stk-offline">⚠ Shelf Offline · last known stock</div>
            )}
            <ul className="stock-list">
              {shownStock.length
                ? shownStock.map((it) => <StockRow key={it.id} item={it} />)
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
