import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';

// Hidden operator "backdoor" — fires the in-memory users API (apps/api, {API_URL})
// so the whole customer lifecycle can be driven from buttons instead of curl.
// Open this in a second tab next to /v5 and watch the 3D store react (the
// dashboard owns the SSE feed; this page is a plain roster manager — it loads
// GET /users, re-fetches after each action, and offers a manual Refresh).
// Nothing links here: type the URL by hand.
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3004';
const USERS_API_URL = `${API_URL}/users`;
const CROWD_API_URL = `${API_URL}/crowd`;
const SHELFS_API_URL = `${API_URL}/shelfs`;

// which actions each status unlocks (mirrors the API's 409 state guards):
//   outside --enter--> waiting --verify--> inside --leave--> paying --pay--> outside
// verify also takes `outside` directly (rolls the enter step in), so Pass /
// Turn away are live from outside too — one click walks them in or turns them
// away without a separate Enter first. pay mirrors this on the exit: live from
// inside/scanning/browsing (rolls the leave step in), one click sends them to
// the gate and charges — no separate Leave first.
// plus the shelf sub-machine while inside:
//   inside --walkToShelf--> scanning --scanQR pass--> browsing --(30s timer)--> inside
//                           scanning --walkAway----> inside
const can = {
  enter: (s) => s === 'outside',
  verify: (s) => s === 'waiting' || s === 'outside',
  leave: (s) => s === 'inside' || s === 'scanning' || s === 'browsing',
  pay: (s) => s === 'paying' || can.leave(s),
  walkToShelf: (s) => s === 'inside',
  scanQR: (s) => s === 'scanning',
  walkAway: (s) => s === 'scanning',
  inspectItem: (s) => s === 'browsing',
};

const GENDERS = ['male', 'female'];
const STATUS_LABEL = {
  outside: 'Outside', waiting: 'Waiting', inside: 'Inside',
  scanning: 'Scanning', browsing: 'Browsing', paying: 'Paying',
};

// a shelf you can actually send someone to: powered, and not the checkout
// counter (it has nothing to enclose — the API 409s it too)
const shelfUsable = (s) => s.online && s.type !== 'checkout';

// the three sign-in providers the API accepts, with a text badge look (emoji +
// per-provider colour class in styles.css — no external icon fetch, CSP-safe)
const AUTH_METHODS = ['google', 'outlook', 'facebook'];
const AUTH_META = {
  google: { label: 'Google', icon: '🟢' },
  outlook: { label: 'Outlook', icon: '📧' },
  facebook: { label: 'Facebook', icon: '🔵' },
};

const initials = (name) =>
  (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase() || '?';

// stable per-id avatar tint so rows are easy to tell apart at a glance
const AVATAR_HUES = [200, 150, 280, 24, 330, 96, 250, 12];
const avatarColor = (id) => `hsl(${AVATAR_HUES[id % AVATAR_HUES.length]} 70% 60%)`;

// avatar_url → <img> (with onError fallback to the initials chip); empty → chip.
// keyed by url at the call site so a changed url remounts and clears any error.
function Avatar({ user }) {
  const [broken, setBroken] = useState(false);
  const showImg = user.avatar_url && !broken;
  return showImg ? (
    // no-referrer: googleusercontent avatars 403 hotlinked requests carrying a
    // Referer header — without this the photo errors out to the chip fallback
    <img className="bd-avatar bd-avatar-img" src={user.avatar_url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  ) : (
    <span className="bd-avatar" style={{ background: avatarColor(user.id) }}>
      {initials(user.name)}
    </span>
  );
}

const EMPTY_EDIT = { name: '', gender: 'male', email: '', avatar_url: '', auth_method: 'google' };

let toastSeq = 0;

export default function Backdoor() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [reloadBusy, setReloadBusy] = useState(false);

  // random ambient crowd (scalar, not roster) — drives the auto shoppers on
  // the right-side doors via /crowd → SSE → scene reconcile
  const [crowd, setCrowd] = useState({ target: 0, max: 5 });
  const [crowdBusy, setCrowdBusy] = useState(false);

  // store layout for the walkToShelf picker (read-only, loaded once) and the
  // per-user shelf choice; browsing rows tick a countdown against browse_until
  const [shelves, setShelves] = useState([]);
  const [shelfPick, setShelfPick] = useState({}); // userId → shelfId
  const [now, setNow] = useState(Date.now());

  // user modal — one form for both add and edit (fields are identical). Mode
  // decides POST vs PATCH on Save; null = closed. editUser holds the row being
  // edited (null in create mode).
  const [modalMode, setModalMode] = useState(null); // 'create' | 'edit'
  const [editUser, setEditUser] = useState(null);
  const [ef, setEf] = useState(EMPTY_EDIT);

  useEffect(() => {
    document.title = 'Backdoor · User Admin';
  }, []);

  const pushToast = useCallback((msg, kind) => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch(USERS_API_URL);
      setUsers(Array.isArray(data) ? data : []);
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // load the current ambient-crowd target once on mount
  useEffect(() => {
    apiFetch(CROWD_API_URL)
      .then((d) => { if (d) setCrowd(d); })
      .catch(() => {});
  }, []);

  // shelf list for the picker — static layout, one fetch is enough
  useEffect(() => {
    apiFetch(SHELFS_API_URL)
      .then((d) => { if (Array.isArray(d)) setShelves(d); })
      .catch(() => {});
  }, []);

  // browsing rows: tick the 30s countdown, and once the API's timer must have
  // fired (browse_until passed), re-fetch so the row drops back to Inside
  useEffect(() => {
    if (!users.some((u) => u.status === 'browsing')) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (users.some((u) => u.status === 'browsing' && u.browse_until != null && Date.now() > u.browse_until + 400)) {
        refresh();
      }
    }, 500);
    return () => clearInterval(t);
  }, [users, refresh]);

  // +/- the random crowd: PATCH the absolute value the stepper would land on
  const bumpCrowd = useCallback(
    async (delta) => {
      const next = Math.max(0, Math.min(crowd.max, crowd.target + delta));
      if (next === crowd.target) return;
      setCrowdBusy(true);
      try {
        const d = await apiFetch(CROWD_API_URL, { method: 'PATCH', body: { target: next } });
        setCrowd(d);
        pushToast(`Random crowd → ${d.target}`, 'ok');
      } catch (e) {
        pushToast(String(e?.message || e), 'err');
      } finally {
        setCrowdBusy(false);
      }
    },
    [crowd, pushToast],
  );

  // one entry point for every mutation: fire → toast → re-fetch. Buttons are
  // already gated by status, so a failure here is a slipped-through 409/404 or
  // a network error — surface it in red.
  const fire = useCallback(
    async ({ method, path = '', body, ok }) => {
      try {
        await apiFetch(`${USERS_API_URL}${path}`, { method, body });
        pushToast(ok, 'ok');
        await refresh();
        return true;
      } catch (e) {
        pushToast(String(e?.message || e), 'err');
        return false;
      }
    },
    [pushToast, refresh],
  );

  // Hard reset: re-run the API's own boot fetch against the external service and
  // replace the roster wholesale. Deliberately not wired through `fire` — this
  // returns the fresh list, so it seeds state straight from the response instead
  // of re-fetching, and it needs the confirm guard below.
  const reloadFromExternal = useCallback(async () => {
    if (!window.confirm(
      'ล้าง roster ทั้งหมดแล้วดึงใหม่จาก external?\n\n'
      + 'สถานะของทุกคนจะหายหมด (คนที่กำลังจ่ายเงิน/เปิดชั้นวางอยู่ก็ด้วย) '
      + 'และคนในฉาก 3D จะ fade ออกทั้งหมด',
    )) return;
    setReloadBusy(true);
    try {
      const data = await apiFetch(`${USERS_API_URL}/roster/refresh`, { method: 'POST' });
      const list = Array.isArray(data) ? data : [];
      setUsers(list);
      setLoadError(null);
      pushToast(`โหลดใหม่แล้ว ${list.length} คน · reload /v5 เพื่อดูในฉาก`, 'ok');
    } catch (e) {
      pushToast(String(e?.message || e), 'err');
    } finally {
      setReloadBusy(false);
    }
  }, [pushToast]);

  // status transitions all hit one endpoint now: POST /:id/status with a
  // { action, payload? } body. enter/leave carry no payload; verify/
  // pay nest a pass/fail result. Thin wrapper over fire so the path and
  // body shape live in one place.
  const act = useCallback(
    (u, action, ok, payload) =>
      fire({
        method: 'POST',
        path: `/${u.id}/status`,
        body: payload ? { action, payload } : { action },
        ok,
      }),
    [fire],
  );

  // ----- user modal (add + edit) -----
  const openCreate = useCallback(() => {
    setEditUser(null);
    setEf(EMPTY_EDIT);
    setModalMode('create');
  }, []);
  const openEdit = useCallback((u) => {
    setEditUser(u);
    setEf({
      name: u.name ?? '',
      gender: u.gender ?? 'male',
      email: u.email ?? '',
      avatar_url: u.avatar_url ?? '',
      auth_method: u.auth_method ?? 'google',
    });
    setModalMode('edit');
  }, []);
  const closeModal = useCallback(() => setModalMode(null), []);

  // Esc closes the modal
  useEffect(() => {
    if (!modalMode) return;
    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalMode, closeModal]);

  const saveModal = useCallback(async () => {
    const name = ef.name.trim();
    if (!name) return;
    const email = ef.email.trim();
    const avatar = ef.avatar_url.trim();

    if (modalMode === 'create') {
      // gender + auth always have a picked value; email/avatar only when typed
      // (blank lets the API fill its defaults: user{id}@demo.local / "")
      const body = { name, gender: ef.gender, auth_method: ef.auth_method };
      if (email) body.email = email;
      if (avatar) body.avatar_url = avatar;
      const okDone = await fire({ method: 'POST', body, ok: `Created ${name}` });
      if (okDone) closeModal();
      return;
    }

    if (!editUser) return;
    // edit: PATCH only what actually changed
    const body = {};
    if (name !== editUser.name) body.name = name;
    if (ef.gender !== editUser.gender) body.gender = ef.gender;
    // email is required on the entity — only send a non-empty change (blanking
    // it would 422 on format:email), so an empty field just means "leave as is"
    if (email && email !== (editUser.email ?? '')) body.email = email;
    if (avatar !== (editUser.avatar_url ?? '')) body.avatar_url = avatar;
    if (ef.auth_method !== editUser.auth_method) body.auth_method = ef.auth_method;
    if (Object.keys(body).length === 0) {
      closeModal();
      return;
    }
    const okDone = await fire({
      method: 'PATCH',
      path: `/${editUser.id}`,
      body,
      ok: `Updated ${name || editUser.name}`,
    });
    if (okDone) closeModal();
  }, [modalMode, editUser, ef, fire, closeModal]);

  return (
    <div className="backdoor">
      <div className="bd-shell">
        <header className="bd-head">
          <div className="bd-brand">
            <h1>BACKDOOR</h1>
            <span>USER LIFECYCLE CONSOLE · {API_URL}</span>
          </div>
          {/* two very different buttons: Refresh only re-reads the store,
              Reload wipes it and re-fetches external — hence the danger look
              and the deliberately un-Refresh-like wording/icon */}
          <div className="bd-headbtns">
            <button className="btn" onClick={refresh}>↻ Refresh</button>
            <button
              className="btn bd-danger"
              onClick={reloadFromExternal}
              disabled={reloadBusy}
              title="Wipe the roster and re-fetch it from the external API"
            >
              {reloadBusy ? '⤓ Reloading…' : '⤓ Reload from External'}
            </button>
          </div>
        </header>

        {/* random ambient crowd — auto shoppers on the right-side doors */}
        <section className="card bd-card">
          <div className="card-head">
            <h2>RANDOM CROWD</h2>
            <span className="pill">auto · right doors</span>
          </div>
          <div className="bd-crowd">
            <button
              className="bd-step"
              disabled={crowdBusy || crowd.target <= 0}
              onClick={() => bumpCrowd(-1)}
              aria-label="Fewer random shoppers"
            >
              −
            </button>
            <div className="bd-crowd-val">
              <span className="bd-crowd-num">{crowd.target}</span>
              <span className="bd-crowd-max">/ {crowd.max}</span>
            </div>
            <button
              className="bd-step"
              disabled={crowdBusy || crowd.target >= crowd.max}
              onClick={() => bumpCrowd(1)}
              aria-label="More random shoppers"
            >
              +
            </button>
            <span className="bd-crowd-hint">walk in &amp; out automatically — not tracked in the roster</span>
          </div>
        </section>

        {/* roster */}
        <section className="card bd-card">
          <div className="card-head card-head--roster">
            <h2>ROSTER</h2>
            <span className="pill">{users.length} users</span>
            <button className="btn bd-add bd-add-user" onClick={openCreate}>+ Add User</button>
          </div>

          {loading ? (
            <div className="bd-empty">Loading…</div>
          ) : loadError ? (
            <div className="bd-error">⚠ {loadError}</div>
          ) : users.length === 0 ? (
            <div className="bd-empty">No users. Add one above.</div>
          ) : (
            <ul className="bd-list">
              {users.map((u) => {
                // shelf the To Shelf button will target: sticky per-row pick,
                // defaulting to the first usable shelf in the layout
                const pick = shelfPick[u.id] ?? shelves.find(shelfUsable)?.id;
                const countdown = u.status === 'browsing' && u.browse_until != null
                  ? Math.max(0, Math.ceil((u.browse_until - now) / 1000))
                  : null;
                return (
                <li className="bd-row" key={u.id}>
                  <Avatar key={u.avatar_url || 'chip'} user={u} />

                  <div className="bd-idcol">
                    <span className="bd-name">{u.name}</span>
                    <span className="bd-sub">
                      <span className="bd-uid">#{u.id}</span>
                      <span className="bd-gmark">{u.gender === 'male' ? '♂' : '♀'}</span>
                      <span className="bd-email">{u.email}</span>
                    </span>
                  </div>

                  <span className={`bd-auth ${u.auth_method}`}>
                    {AUTH_META[u.auth_method]?.icon} {AUTH_META[u.auth_method]?.label ?? u.auth_method}
                  </span>

                  <span className={`bd-status ${u.status}`}>{STATUS_LABEL[u.status] ?? u.status}</span>

                  <div className="bd-actions">
                    <button className="bd-act edit" onClick={() => openEdit(u)}>✎ Edit</button>
                    <button
                      className="bd-act in"
                      disabled={!can.enter(u.status)}
                      onClick={() => act(u, 'enter', `${u.name} entered`)}
                    >
                      Enter
                    </button>
                    <button
                      className="bd-act ok"
                      disabled={!can.verify(u.status)}
                      onClick={() => act(u, 'verify', `${u.name} verified`, { result: 'pass' })}
                    >
                      Verify ✓
                    </button>
                    <button
                      className="bd-act bad"
                      disabled={!can.verify(u.status)}
                      onClick={() => act(u, 'verify', `${u.name} turned away`, { result: 'fail' })}
                    >
                      Verify ✗
                    </button>
                    <button
                      className="bd-act out"
                      disabled={!can.leave(u.status)}
                      onClick={() => act(u, 'leave', `${u.name} sent to pay`)}
                    >
                      Leave
                    </button>
                    <button
                      className="bd-act ok"
                      disabled={!can.pay(u.status)}
                      onClick={() => act(u, 'pay', `${u.name} paid`, { result: 'pass' })}
                    >
                      Pay ✓
                    </button>
                    <button
                      className="bd-act bad"
                      disabled={!can.pay(u.status)}
                      onClick={() => act(u, 'pay', `${u.name} payment declined`, { result: 'fail' })}
                    >
                      Pay ✗
                    </button>
                    <button
                      className="bd-act del"
                      onClick={() => fire({ method: 'DELETE', path: `/${u.id}`, ok: `Deleted ${u.name}` })}
                    >
                      Delete
                    </button>
                  </div>

                  {/* shelf sub-machine strip — appears only in the statuses
                      where its actions are legal, so the visible buttons ARE
                      the state machine (inside → scanning → browsing) */}
                  {u.status === 'inside' && (
                    <div className="bd-shelfstrip">
                      <span className="bd-shelf-lbl">SHELF</span>
                      <select
                        className="bd-shelfsel"
                        value={pick ?? ''}
                        onChange={(e) => setShelfPick((s) => ({ ...s, [u.id]: Number(e.target.value) }))}
                      >
                        {shelves.map((s) => (
                          <option key={s.id} value={s.id} disabled={!shelfUsable(s)}>
                            #{s.id} {s.name}{!s.online ? ' — offline' : s.type === 'checkout' ? ' — no doors' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        className="bd-act in"
                        disabled={pick == null}
                        onClick={() => act(u, 'walkToShelf', `${u.name} → shelf #${pick}`, { shelfId: pick })}
                      >
                        → To Shelf
                      </button>
                    </div>
                  )}
                  {u.status === 'scanning' && (
                    <div className="bd-shelfstrip">
                      <span className="bd-shelf-lbl">AT SHELF #{u.shelf_id}</span>
                      <button
                        className="bd-act ok"
                        onClick={() => act(u, 'scanQR', `${u.name} scanned in`, { result: 'pass' })}
                      >
                        Scan ✓
                      </button>
                      <button
                        className="bd-act bad"
                        onClick={() => act(u, 'scanQR', `${u.name} scan rejected`, { result: 'fail' })}
                      >
                        Scan ✗
                      </button>
                      <button
                        className="bd-act out"
                        onClick={() => act(u, 'walkAway', `${u.name} walked away`)}
                      >
                        Walk Away
                      </button>
                    </div>
                  )}
                  {u.status === 'browsing' && (
                    <div className="bd-shelfstrip">
                      <span className="bd-shelf-lbl">SHELF #{u.shelf_id} OPEN</span>
                      <button
                        className="bd-act ok"
                        onClick={() => act(u, 'inspectItem', `${u.name} kept an item`, { result: 'keep' })}
                      >
                        Inspect · Keep
                      </button>
                      <button
                        className="bd-act"
                        onClick={() => act(u, 'inspectItem', `${u.name} returned an item`, { result: 'return' })}
                      >
                        Inspect · Return
                      </button>
                      {countdown != null && (
                        <span className="bd-countdown" title="door auto-closes when this hits 0">
                          ⏱ {countdown}s
                        </span>
                      )}
                    </div>
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* user modal — add + edit */}
      {modalMode && (
        <div className="bd-modal-backdrop" onClick={closeModal}>
          <div className="bd-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="bd-modal-head">
              <h3>{modalMode === 'create' ? 'Add User' : `Edit User #${editUser.id}`}</h3>
              <button className="detail-close" onClick={closeModal} title="Close (Esc)">✕</button>
            </div>
            <div className="bd-modal-body">
              <div className="bd-modal-avatar">
                <Avatar
                  key={ef.avatar_url || 'chip'}
                  user={{ id: editUser?.id ?? 0, name: ef.name, avatar_url: ef.avatar_url }}
                />
              </div>
              <label className="bd-field">
                <span>Name</span>
                <input
                  className="bd-input"
                  value={ef.name}
                  onChange={(e) => setEf((s) => ({ ...s, name: e.target.value }))}
                />
              </label>
              <label className="bd-field">
                <span>Email</span>
                <input
                  className="bd-input"
                  type="email"
                  value={ef.email}
                  onChange={(e) => setEf((s) => ({ ...s, email: e.target.value }))}
                />
              </label>
              <label className="bd-field">
                <span>Avatar URL</span>
                <input
                  className="bd-input"
                  placeholder="(empty → initials chip)"
                  value={ef.avatar_url}
                  onChange={(e) => setEf((s) => ({ ...s, avatar_url: e.target.value }))}
                />
              </label>
              <div className="bd-field">
                <span>Gender</span>
                <div className="bd-gender">
                  {GENDERS.map((g) => (
                    <button
                      type="button"
                      key={g}
                      className={`bd-gbtn${ef.gender === g ? ' active' : ''}`}
                      onClick={() => setEf((s) => ({ ...s, gender: g }))}
                    >
                      {g === 'male' ? '♂' : '♀'} {g}
                    </button>
                  ))}
                </div>
              </div>
              <div className="bd-field">
                <span>Auth method</span>
                <div className="bd-authpick">
                  {AUTH_METHODS.map((a) => (
                    <button
                      type="button"
                      key={a}
                      className={`bd-gbtn${ef.auth_method === a ? ' active' : ''}`}
                      onClick={() => setEf((s) => ({ ...s, auth_method: a }))}
                    >
                      {AUTH_META[a].icon} {a}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="bd-modal-foot">
              <button className="btn" onClick={closeModal}>Cancel</button>
              <button className="btn bd-add" onClick={saveModal} disabled={!ef.name.trim()}>
                {modalMode === 'create' ? '+ Add' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* toasts */}
      <div className="bd-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`bd-toast ${t.kind}`}>
            <span className="bd-toast-ico">{t.kind === 'ok' ? '✓' : '⚠'}</span>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
