import { useState } from 'react';

// Person avatar chip: the API customer's `avatar_url` as an <img>, falling back
// to the initials chip (torso-tinted) when there's no url, it fails to load, or
// the person is a walk-in (avatarUrl ''). Key this by url at the call site so a
// changed url remounts and clears a stale onError.
//
// Lives in its own file rather than beside its first caller: the Dashboard rows,
// the floating person card and the head name tags all draw the same chip, and
// importing it back out of Dashboard.jsx would close an import cycle.
export default function PersonAvatar({ person, className = '' }) {
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
