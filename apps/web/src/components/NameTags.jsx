import { useCallback, useEffect, useState } from 'react';
import PersonAvatar from './PersonAvatar.jsx';

// "NAME TAGS" mode (bottom-bar toggle): a photo + name pill over EVERY body in
// the store at once, not just the selected one.
//
// Same split as the event cards in HeadCards.jsx — React owns what a tag says,
// the scene owns the per-frame follow transform — but the trigger is inverted.
// Every other head card is armed by an event (an SSE lands, the gesture that
// earned it finishes, the scene reveals it); a name tag has no event behind it,
// so this polls the scene's roster instead. 1s, borrowed from the CUSTOMERS
// list's cadence: a tag can lag a second behind someone walking in, which is
// swallowed by the walk through the doorway, and nothing has to lag on the way
// out — `targetOf()` goes null the frame a body is gone and the scene hides the
// node immediately, whatever this list still believes.
//
// Content is deliberately just the avatar and the name: those are fixed for a
// body's whole life, so a tag binds once and never re-renders. Status/near-shelf
// would drag every tag into the 1s poll, and 13 two-line cards over a crowd is
// a wall — the CUSTOMERS list and the person card already answer that question.
const POLL_MS = 1000;

function NameTag({ person, peopleRef }) {
  // stable per person id, so React doesn't unbind/rebind (and re-hide until the
  // next tracked frame) on each poll's re-render
  const bind = useCallback(
    (el) => { peopleRef.current?.bindNameTag?.(person.id, el); },
    [peopleRef, person.id],
  );
  return (
    <div className="ntag-track" ref={bind}>
      <div className="ntag">
        <PersonAvatar key={person.avatarUrl || 'chip'} person={person} className="ntag-av" />
        <span className="ntag-name">{person.name}</span>
      </div>
    </div>
  );
}

export function NameTags({ peopleRef }) {
  const [people, setPeople] = useState([]);

  useEffect(() => {
    const read = () => setPeople(peopleRef.current?.list?.() ?? []);
    read();
    const t = setInterval(read, POLL_MS);
    return () => clearInterval(t);
  }, [peopleRef]);

  // One layer wrapping every tag, and it is load-bearing: the scene writes a
  // depth-ordered z-index onto each tag so the near shopper's tag covers the far
  // one's (they line up in the entry and pay queues, where two tags land on the
  // same pixel). A z-index that free would otherwise have to compete with the
  // rest of the dashboard — the person card at 22, the pills at 24, the bar at 6
  // — so the layer's own z-index opens a stacking context: inside it the tags
  // are free to use the full range, and no tag can ever climb above the layer
  // itself. It sits UNDER all of that chrome on purpose; tags are ambient, and
  // 13 of them must never cover the bottom bar or the roster panel.
  return (
    <div className="ntag-layer">
      {people.map((p) => <NameTag key={p.id} person={p} peopleRef={peopleRef} />)}
    </div>
  );
}

// Toggle state for the bottom bar. Persisted, unlike the floor/2D-3D controls
// beside it: those are a glance at the scene, this is how someone wants to WATCH
// it, and losing it on every reload of a live demo is the annoying half of the
// trade. Default off — a fresh load shows the scene, not 13 pills over it.
const KEY = 'smartstore.nameTags';

export function useNameTagMode() {
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; } // private mode / blocked storage
  });
  // Persisted from an effect rather than from inside the updater. An updater has
  // to be pure: React is free to call it more than once (StrictMode does, in
  // dev) and at a moment that has nothing to do with the commit — writing there
  // let two toggles in one tick leave the stored value disagreeing with what was
  // on screen. One write per committed value, which is the thing we mean.
  useEffect(() => {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* nothing to do — keep the in-memory flag */ }
  }, [on]);
  // a setter, not a flip: the bar drives this from a two-button ON|OFF segment,
  // where pressing the side that is already lit has to be a no-op
  return [on, setOn];
}
