import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/* ---------- game-style boot progress ----------
 * One continuous 0→100% screen covering everything between "page opened" and
 * "store is on screen with its crowd in it".
 *
 * The catch that shapes the whole design: the Babylon scene build is synchronous
 * and blocks the main thread for seconds, so nothing JS-driven can animate
 * across it. Both the bar and the number therefore run as CSS transitions on
 * `transform` (compositor-only) driven by two custom properties on the splash
 * root — `--p` (0..100) and `--d` (transition duration). The JS side only ever
 * sets a TARGET; the browser keeps painting the motion toward it even while the
 * main thread is wedged.
 *
 * Because of that, a phase sets its END value when it STARTS, with a duration
 * roughly its expected length: finish early and the bar accelerates into the
 * next target, run long and it parks. Progress is clamped monotonic — it never
 * rewinds, whatever order the milestones land in.
 */

// weight of each phase, summing to 100
const W = { data: 12, build: 33, frame: 10, models: 45 };
// how long each phase is expected to take — the transition duration, not a timeout
const DUR = { data: 1.8, build: 2.6, settle: 0.25, frame: 0.5, models: 5, model: 0.4, finish: 0.3 };
// Character files resolve whenever they resolve — with a warm cache all nine
// parse inside the build's block and tick within milliseconds of each other,
// which left the bar parked at 45% for seconds and then jumping. So the model
// phase gets the same optimistic creep the build does, capped short of its full
// weight: the glide can never reach 100% on its own, only real ticks can.
const MODEL_CREEP = 0.8;

const FLOOR_MS = 1200;    // never reveal sooner than this — a sub-second splash reads as a flash
const HOLD_MS = 250;      // beat at 100% before the fade, so the bar is seen landing
const WATCHDOG_MS = 15000; // nothing may leave the user staring at a parked bar

const LABEL = {
  data: 'LOADING STORE DATA',
  build: 'BUILDING STORE',
  frame: 'COMPILING SHADERS',
  model: 'LOADING SHOPPERS',
  ready: 'ENTERING STORE',
};

// the odometer strip: 0…100 stacked in a one-line window (see .boot-odo)
const DIGITS = Array.from({ length: 101 }, (_, i) => i);

/* progress ledger + the imperative --p/--d driver.
 * `active` only decides whether the splash starts visible; every caller today
 * (v5) boots behind it. */
export function useBootProgress(active = true) {
  const rootRef = useRef(null);
  const st = useRef({
    pct: 0, data: false, built: false, frame: false, models: 0, total: 9,
    building: false, start: 0, done: false,
  });
  const [label, setLabel] = useState(LABEL.data);
  const [detail, setDetail] = useState('');
  const [error, setError] = useState(null);
  const [visible, setVisible] = useState(active);

  // the only writer of --p/--d. Straight to the DOM rather than through React:
  // the build target has to be committed and painted in the frame *before* the
  // blocking build starts, and a state update can't promise that.
  const apply = useCallback((target, dur) => {
    const s = st.current;
    s.pct = Math.min(100, Math.max(s.pct, target)); // monotonic
    const el = rootRef.current;
    if (!el) return;
    el.style.setProperty('--p', String(s.pct));
    el.style.setProperty('--d', `${dur}s`);
  }, []);

  const settled = () => {
    const s = st.current;
    return (s.data ? W.data : 0) + (s.built ? W.build : 0) + (s.frame ? W.frame : 0)
      + (s.total ? (W.models * s.models) / s.total : 0);
  };
  // the build's weight is either being crept across or already settled — never
  // both, and never twice. Anything else double-counts 33 points and lands the
  // bar on a number that doesn't correspond to any real state.
  const creep = () => (st.current.building && !st.current.built ? W.build : 0);

  const finish = useCallback(() => {
    const s = st.current;
    if (s.done) return;
    s.done = true;
    setLabel(LABEL.ready); setDetail('');
    apply(100, DUR.finish);
    const elapsed = performance.now() - s.start;
    const wait = Math.max(FLOOR_MS - elapsed, DUR.finish * 1000 + HOLD_MS);
    setTimeout(() => setVisible(false), wait);
  }, [apply]);

  const mark = useCallback((ev) => {
    const s = st.current;
    if (s.done) return;
    const phase = typeof ev === 'string' ? ev : ev?.phase;
    switch (phase) {
      case 'data': // catalogue fetched + validated
        s.data = true;
        apply(settled(), DUR.settle);
        break;
      case 'build': // about to enter the blocking build — creep across it
        if (s.built || s.building) break; // arm once; a re-arm re-creeps a paid phase
        s.building = true;
        setLabel(LABEL.build);
        apply(settled() + creep(), DUR.build);
        break;
      case 'built':
        s.built = true; s.building = false;
        apply(settled(), DUR.settle);
        // hand straight over to the model creep — the settle above is a 0.25s
        // step, and without this the bar would stand still until a file lands
        setTimeout(() => {
          if (!s.done) apply(settled() + W.models * MODEL_CREEP, DUR.models);
        }, DUR.settle * 1000);
        break;
      case 'frame': // first real frame is on screen
        s.frame = true;
        setLabel(LABEL.frame);
        apply(settled(), DUR.frame);
        break;
      case 'model': // one character file resolved (or failed — still a tick)
        s.models = ev.loaded; s.total = ev.total || s.total;
        setLabel(LABEL.model);
        setDetail(`${ev.loaded}/${s.total}`);
        // still mid-build? keep its creep in the target so the bar can't stall
        apply(settled() + creep(), DUR.model);
        break;
      case 'ready':
        finish();
        break;
      default:
        break;
    }
  }, [apply, finish]);

  // stable onReady for the scene contract (StoreStage tears the scene down if
  // its callbacks change identity)
  const ready = useCallback(() => mark('ready'), [mark]);

  const fail = useCallback((msg) => {
    setError(String(msg));
    setDetail('');
  }, []);

  // back to a clean 0% for a RETRY
  const reset = useCallback(() => {
    st.current = { pct: 0, data: false, built: false, frame: false, models: 0, total: 9, building: false, start: performance.now(), done: false };
    setError(null); setDetail(''); setLabel(LABEL.data);
    const el = rootRef.current;
    if (el) { el.style.setProperty('--d', '0.2s'); el.style.setProperty('--p', '0'); }
    // let the rewind paint before the data creep re-arms
    setTimeout(() => apply(W.data, DUR.data), 220);
  }, [apply]);

  // arm the first creep once the element exists, and start the floor clock
  useLayoutEffect(() => {
    st.current.start = performance.now();
    apply(W.data, DUR.data);
  }, [apply]);

  // last resort: a hung fetch or a model that never settles must not strand the
  // splash — force it through rather than leave a parked bar on screen
  useEffect(() => {
    const t = setTimeout(() => { if (!st.current.done && !error) finish(); }, WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [finish, error]);

  return { rootRef, label, detail, error, visible, mark, ready, fail, reset };
}

export default function BootSplash({ boot, onRetry }) {
  const { rootRef, label, detail, error, visible } = boot;
  return (
    <div
      ref={rootRef}
      className={`loading boot${visible ? '' : ' hidden'}${error ? ' boot-failed' : ''}`}
      role="progressbar"
      aria-label="Loading store"
    >
      <div className="boot-grid" aria-hidden="true" />
      <div className="boot-card">
        <h1 className="boot-title">SMART STORE</h1>
        <p className="boot-sub">digital twin · babylon.js</p>

        <div className="boot-bar">
          <div className="boot-fill">
            <span className="boot-shimmer" aria-hidden="true" />
          </div>
        </div>

        <div className="boot-status">
          <span className="boot-label">
            {error ? `⚠ ${error}` : label}
            {!error && detail ? <em className="boot-detail">{detail}</em> : null}
          </span>
          {/* odometer: the whole 0…100 column scrolls behind a one-line window,
              so the number rides the same compositor transition as the bar and
              can't freeze out of sync with it while the build blocks */}
          <span className="boot-pct" aria-hidden="true">
            <span className="boot-odo-win">
              <span className="boot-odo">
                {DIGITS.map((d) => <span key={d}>{d}</span>)}
              </span>
            </span>
            <i>%</i>
          </span>
        </div>

        {error && (
          <button className="boot-retry" onClick={onRetry}>RETRY</button>
        )}
      </div>
    </div>
  );
}
