import { useCallback, useEffect, useRef, useState } from 'react';

// Event cards that float over an API customer's head in the 3D scene.
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
// Two lifetimes live in one registry, split by kind:
//
//   BROWSE card — one per shelf visit. Opens on the scanQR pass reading
//   `SCANNED`, and from the first pick onward it is the shopper's basket at that
//   shelf: a steady HELD count plus the OUT/IN breakdown, rewritten in place on
//   every pick and return. It has no clock of its own; the scene closes it when
//   the visit really ends (holdEventCard). Rewritten IN PLACE is the whole point
//   — remounting it would replay the pop-in on every pick, which is a card that
//   flinches every few seconds over someone's head.
//
//   REJECT card — the scan-fail flash, 2s + fade, unchanged. A failed scan never
//   enters browsing (the shopper stays at the reader to rescan), so it can never
//   collide with a browse card for the one slot above a head.
//
// One card per person either way: a second card replaces the first outright.

const HOLD_MS = 2000; // transient cards — matches the verify/pay bubble
const FADE_MS = 400;
const BADGE_MS = 1100; // the +2 that flies in over a live browse card

// stroke icons rather than emoji: meaning here is carried by COLOUR and emoji
// render in the system's own palette, which would break half of that.
// currentColor makes each icon inherit its card's accent.
const BASKET = (
  <path d="M4 13l1.6 6.2a1.6 1.6 0 001.6 1.2h9.6a1.6 1.6 0 001.6-1.2L20 13z" />
);
const ICONS = {
  scanned: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.4l2.6 2.6L16 9.6" />
    </>
  ),
  reject: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  basket: BASKET,
  pick: (<><path d="M12 3v8m0 0l-3-3m3 3l3-3" />{BASKET}</>),
  return: (<><path d="M12 11V3m0 0L9 6m3-3l3 3" />{BASKET}</>),
};

function Icon({ name, className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

// The running tally, in the one place the summary becomes words.
//
// `HELD` alone cannot tell "picked 3, put 1 back" from "picked 2" — they are the
// same number — so the breakdown appears the moment anything has come back, and
// stays folded away when nothing has (three counts for a plain pick is noise).
// It renders at every value including 0: a basket emptied by returns still has a
// story, and the pill must not change height mid-visit — it is stacked over the
// person detail card, so a line that comes and goes moves the whole stack.
function Tally({ summary }) {
  const { takenTotal: held, pickedOutTotal: out, addedInTotal: back } = summary;
  return (
    <>
      <span className={held === 0 ? 'dim' : undefined}>HELD {held}</span>
      {back > 0 && <> · OUT {out} · IN {back}</>}
    </>
  );
}

function HeadCard({ card, peopleRef }) {
  // stable per apiId so React does not unbind/rebind the node (and restart its
  // hidden-until-first-tracked-frame state) on every re-render
  const bind = useCallback(
    (el) => { peopleRef.current?.bindEventCard?.(card.apiId, el); },
    [peopleRef, card.apiId],
  );
  const browsing = card.kind === 'browse';
  // green while the scan verdict is all it has to say; blue once the first item
  // moves, and it STAYS blue — flipping to amber on every return would make a
  // card that lives half a minute blink between two colours. The momentary
  // badge carries the pick/return colour instead.
  const accent = !browsing ? 'reject' : card.summary ? 'pick' : 'pass';
  return (
    // the kind class rides the TRACK, not the pill: the accent custom properties
    // it sets have to be inherited by the track's own ::after nub too
    <div className={`hcard-track hcard-${accent}${card.closing ? ' closing' : ''}`} ref={bind}>
      <div className="hcard">
        <Icon className="hcard-ico" name={browsing ? (card.summary ? 'basket' : 'scanned') : 'reject'} />
        {card.summary && <span className="hcard-num">{card.summary.takenTotal}</span>}
        <span className="hcard-txt">
          <b>{card.title}</b>
          <i>{card.summary ? <Tally summary={card.summary} /> : card.sub}</i>
        </span>
        {/* keyed so each event remounts the badge and replays its flight, while
            the card around it stays mounted and never re-pops */}
        {card.badge && (
          <span key={card.badge.seq} className={`hcard-badge hcard-${card.badge.kind}`}>
            <Icon className="hcard-badge-ico" name={card.badge.kind} />
            {card.badge.text}
          </span>
        )}
      </div>
    </div>
  );
}

export function HeadCards({ cards, peopleRef }) {
  return cards.map((c) => (
    // seq in the key remounts the node when a card is REPLACED, so the pop-in
    // animation replays instead of the new content sliding in silently. A browse
    // card holds its seq across updates for the opposite reason — see above.
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

  const put = useCallback((apiId, next) => {
    setCards((prev) => [...prev.filter((c) => c.apiId !== apiId), next]);
  }, []);

  // fade out and unmount — the one exit for both kinds
  const close = useCallback((apiId) => {
    clear(apiId);
    setCards((prev) => prev.map((c) => (c.apiId === apiId ? { ...c, closing: true } : c)));
    timers.current.set(apiId, [
      setTimeout(() => {
        setCards((prev) => prev.filter((c) => c.apiId !== apiId));
        timers.current.delete(apiId);
      }, FADE_MS),
    ]);
  }, [clear]);

  // transient card: shows, holds, fades. Scan rejects only.
  const show = useCallback((card) => {
    clear(card.apiId);
    seq.current += 1;
    put(card.apiId, { ...card, closing: false, seq: seq.current });
    timers.current.set(card.apiId, [setTimeout(() => close(card.apiId), HOLD_MS)]);
  }, [clear, close, put]);

  // browse card: opens with no clock and hands the scene its closer
  const open = useCallback((card) => {
    clear(card.apiId);
    seq.current += 1;
    put(card.apiId, { ...card, closing: false, summary: null, badge: null, seq: seq.current });
    peopleRef.current?.holdEventCard?.(card.apiId, () => close(card.apiId));
  }, [clear, close, put, peopleRef]);

  // a pick or return landed on a live browse card: rewrite the tally in place and
  // fly the delta in. `seq` deliberately does NOT move — see HeadCards above.
  const update = useCallback((apiId, summary, badge) => {
    seq.current += 1;
    const badgeSeq = seq.current;
    setCards((prev) => prev.map((c) => (
      c.apiId === apiId && c.kind === 'browse'
        ? { ...c, summary, badge: badge && { ...badge, seq: badgeSeq } }
        : c
    )));
    // the badge is a moment, the tally is the state: drop the badge again but
    // leave the numbers standing
    const hs = timers.current.get(apiId) ?? [];
    timers.current.set(apiId, [...hs, setTimeout(() => {
      setCards((prev) => prev.map((c) => (
        c.apiId === apiId && c.badge?.seq === badgeSeq ? { ...c, badge: null } : c
      )));
    }, BADGE_MS)]);
  }, []);

  // hand the card to the scene and wait: it decides whether this one ever runs
  const arm = useCallback((card, run) => {
    if (card.apiId == null) return;
    peopleRef.current?.armEventCard?.(card.apiId, (revealed) => { if (revealed) run(card); });
  }, [peopleRef]);

  // ---- the three things the dashboard calls ----

  // scanQR verdict. A pass opens the browse card; a fail is a flash.
  const armScan = useCallback((apiId, result, sku, productName) => {
    const title = productName || sku || 'Item';
    if (result === 'pass') arm({ apiId, kind: 'browse', title, sub: 'SCANNED' }, open);
    else arm({ apiId, kind: 'reject', title, sub: 'SCAN REJECTED' }, show);
  }, [arm, open, show]);

  // pick/return off the loadcell (or the Backdoor). The card is already up — this
  // only rewrites it, and only once the reaching hand comes back down.
  //
  // The badge is skipped when the event moved nothing: a return of something the
  // shopper isn't holding is a real command with a real gesture, but "−0" is not
  // a fact worth animating. The tally still refreshes.
  const armPickReturn = useCallback((apiId, s) => {
    const back = s.action === 'return';
    const moved = back ? s.summary.eventAddedQty : s.summary.eventPickedQty;
    arm({ apiId }, () => update(apiId, s.summary, moved > 0 && {
      kind: back ? 'return' : 'pick',
      text: `${back ? '−' : '+'}${moved}`,
    }));
  }, [arm, update]);

  useEffect(() => () => {
    timers.current.forEach((hs) => hs.forEach(clearTimeout));
    timers.current.clear();
  }, []);

  // console handle, alongside the scene's own `__storeBabylon`. A browse card is
  // normally only reachable through a scan pass followed by a loadcell event, so
  // without this there is no way to put one on screen and look at it.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    window.__headCards = { armScan, armPickReturn, open, show, update, close };
    return () => { delete window.__headCards; };
  }, [armScan, armPickReturn, open, show, update, close]);

  return { cards, armScan, armPickReturn };
}
