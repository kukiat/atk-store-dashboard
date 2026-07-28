import { useCallback, useEffect, useRef, useState } from 'react';

// Event cards that float over an API customer's head in the 3D scene: the shelf
// scan verdict, and each pick/return off the loadcell.
//
// Split of responsibility (the same contract the verify/pay face bubble uses):
// React owns what a card says, how long it lives and what it looks like; the
// scene owns the per-frame follow transform and — crucially — *when* a card
// appears. An SSE event lands seconds before the shopper's body acts on it (they
// may still be walking to the shelf, or the gesture may be queued behind
// another), so a card popped on arrival would float over someone standing still.
// Instead every card is ARMED here and revealed by the scene when the gesture
// that earned it finishes; if that gesture never runs — the shopper walked away,
// the session closed, the body despawned — the scene calls back with `false` and
// the card is silently dropped, never shown.
//
// One card per person: a second event replaces the first outright (content and
// clock both reset) rather than stacking, because there is only one point above
// a head to put anything.

const HOLD_MS = 2000; // matches the verify/pay bubble — one rhythm for all head cards
const FADE_MS = 400;

// stroke icons rather than emoji: meaning here is carried by COLOUR (four kinds,
// four accents) and emoji render in the system's own palette, which would break
// half of that. currentColor makes each icon inherit its card's accent.
const ICONS = {
  pass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.4l2.6 2.6L16 9.6" />
    </>
  ),
  fail: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  pick: (
    <>
      <path d="M12 3v8m0 0l-3-3m3 3l3-3" />
      <path d="M4 13l1.6 6.2a1.6 1.6 0 001.6 1.2h9.6a1.6 1.6 0 001.6-1.2L20 13z" />
    </>
  ),
  return: (
    <>
      <path d="M12 11V3m0 0L9 6m3-3l3 3" />
      <path d="M4 13l1.6 6.2a1.6 1.6 0 001.6 1.2h9.6a1.6 1.6 0 001.6-1.2L20 13z" />
    </>
  ),
};

function HeadCard({ card, peopleRef }) {
  // stable per apiId so React does not unbind/rebind the node (and restart its
  // hidden-until-first-tracked-frame state) on every re-render
  const bind = useCallback(
    (el) => { peopleRef.current?.bindEventCard?.(card.apiId, el); },
    [peopleRef, card.apiId],
  );
  return (
    // the kind class rides the TRACK, not the pill: the accent custom properties
    // it sets have to be inherited by the track's own ::after nub too
    <div className={`hcard-track hcard-${card.kind}${card.closing ? ' closing' : ''}`} ref={bind}>
      <div className="hcard">
        <svg className="hcard-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {ICONS[card.kind]}
        </svg>
        {card.delta && <span className="hcard-num">{card.delta}</span>}
        <span className="hcard-txt">
          <b>{card.title}</b>
          {card.sub && <i>{card.sub}</i>}
        </span>
      </div>
    </div>
  );
}

export function HeadCards({ cards, peopleRef }) {
  return cards.map((c) => (
    // seq in the key remounts the node when a card is replaced in place, so the
    // pop-in animation replays instead of the new content sliding in silently
    <HeadCard key={`${c.apiId}:${c.seq}`} card={c} peopleRef={peopleRef} />
  ));
}

export function useHeadCards(peopleRef) {
  const [cards, setCards] = useState([]);
  const timers = useRef(new Map()); // apiId -> timeout handles
  const seq = useRef(0);

  const clear = useCallback((apiId) => {
    (timers.current.get(apiId) ?? []).forEach(clearTimeout);
    timers.current.delete(apiId);
  }, []);

  const show = useCallback((card) => {
    clear(card.apiId);
    const id = card.apiId;
    seq.current += 1;
    const next = { ...card, closing: false, seq: seq.current };
    setCards((prev) => [...prev.filter((c) => c.apiId !== id), next]);
    timers.current.set(id, [
      setTimeout(
        () => setCards((prev) => prev.map((c) => (c.apiId === id ? { ...c, closing: true } : c))),
        HOLD_MS,
      ),
      setTimeout(() => {
        setCards((prev) => prev.filter((c) => c.apiId !== id));
        timers.current.delete(id);
      }, HOLD_MS + FADE_MS),
    ]);
  }, [clear]);

  // hand the card to the scene and wait: it decides whether this one ever runs
  const arm = useCallback((card) => {
    if (card.apiId == null) return;
    peopleRef.current?.armEventCard?.(card.apiId, (revealed) => { if (revealed) show(card); });
  }, [peopleRef, show]);

  useEffect(() => () => {
    timers.current.forEach((hs) => hs.forEach(clearTimeout));
    timers.current.clear();
  }, []);

  // console handle, alongside the scene's own `__storeBabylon`. Every card here
  // lives ~2.4s and is normally only reachable through a loadcell event, so
  // without this there is no way to put one on screen and look at it.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    window.__headCards = { arm, scanCard, pickCard };
    return () => { delete window.__headCards; };
  }, [arm]);

  return { cards, armCard: arm };
}

// ---- card builders: the one place the SSE payloads become card content ----

// scanQR verdict. The event carries the sku but no display name, so the caller
// resolves it against the shelf catalog the dashboard already holds; a sku with
// no match falls back to the raw sku rather than dropping the line, which keeps
// every pill two lines tall (they stack over the detail card, so a short one
// would make the stack height jump).
export const scanCard = (apiId, result, sku, productName) => ({
  apiId,
  kind: result === 'pass' ? 'pass' : 'fail',
  title: result === 'pass' ? 'SCANNED' : 'REJECTED',
  sub: productName || sku || null,
  delta: null,
});

// loadcell (or commanded) pick/return. The big number is THIS event, the
// sub-line is the running total for the sku — `deltaQty` alone loses the total
// under latest-wins, and the total alone answers the wrong question on a return.
// Sign comes from `action`, not from deltaQty's sign: that field is the
// shelf-side delta, so a pick reads negative there.
export const pickCard = (apiId, s) => ({
  apiId,
  kind: s.action === 'return' ? 'return' : 'pick',
  title: s.name || s.sku || 'Item',
  // a return that empties the line would read "Total 0", which says nothing the
  // −1 and the product name have not already said
  sub: s.qty > 0 ? `Total ${s.qty}` : null,
  delta: `${s.action === 'return' ? '−' : '+'}${Math.abs(s.deltaQty) || 1}`,
});
