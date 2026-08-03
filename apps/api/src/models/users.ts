// Central domain types for the users module. These are the plain TypeScript
// shapes (the service's data model); the Elysia/TypeBox validation schemas that
// mirror them live in ../modules/users/users.model.ts.
export type UserStatus =
  | "outside"
  | "waiting"
  | "inside"
  | "scanning"
  | "browsing"
  | "paying";
export type AuthMethod = "google" | "outlook" | "facebook";
export type User = {
  // OUR key: a uuid we mint (crypto.randomUUID()), never accepted from a
  // request body. Addresses GET/PATCH/DELETE /users/:id.
  id: string;
  // THEIR key: the outside world's id for this same customer — the external
  // roster's row id, or a generated stand-in (EXTERNAL_ID_BASE+) for someone
  // born in the Backdoor with no counterpart out there. Unique, and the ONLY
  // thing POST /users/:externalId/status accepts. A uuid can never be mistaken
  // for one of these at a glance, which is the point of the split.
  external_id: number;
  name: string;
  gender: "male" | "female";
  status: UserStatus;
  // shelf session (scanning/browsing only): which shelf they hold at; null
  // otherwise. Ends on an explicit shelfClose (or leave) — no auto-close.
  // A shelf id is the device_id string from the IoT feed (see Shelf in ./shelfs).
  shelf_id: string | null;
  // when this visit started, ISO 8601 — seeded from the external feed's
  // `entered_at` at boot, stamped on a verify pass, cleared when they go
  // `outside`. The dashboard counts its "In store" timer from here, so it has
  // to survive a page reload (a scene-clock counter would restart at 0).
  entered_at: string | null;
  // ISO 8601, restamped by UsersService.touch on EVERY mutation — create,
  // update and every status action. The dashboard sorts its Exited list on it
  // (newest first), which is why it has to be a real clock and not a stand-in
  // like the id: uuids carry no order and `entered_at` is null on both a
  // never-entered customer and one who paid and left.
  updated_at: string;
  // display-only profile fields (see ../modules/users/users.model.ts)
  email: string;
  avatar_url: string;
  auth_method: AuthMethod;
};
// every `id` below is the uuid User.id — external_id never rides the feed as a
// key, it is only a field on the User payloads
export type UserEvent =
  | { type: "added" | "updated" | "enter"; user: User }
  | { type: "removed" | "leave" | "walkAway" | "shelfClose"; user: { id: string } }
  // verify carries an optional, transient imageURL (the face photo to flash on
  // a pass) — it rides the event only, never lands on the stored User.
  | {
    type: "verify" | "pay";
    user: { id: string; result: "pass" | "fail"; imageURL?: string };
  }
  // scanQR carries the scanned sku too, so the feed reflects what was scanned
  | { type: "scanQR"; user: { id: string; result: "pass" | "fail"; sku: string } }
  | { type: "walkToShelf"; user: { id: string; shelfId: string } }
  | { type: "inspectItem"; user: { id: string; result: "keep" | "return" } }
  // roster refresh: the whole store in one event, not a per-user delta. The
  // only variant that carries `users` (an array) instead of `user` — the SSE
  // route picks the right field. See refreshRoster for why it isn't a
  // removed/added storm.
  | { type: "roster"; users: User[] };

// body of POST /:id/status — mirror of the "users.action" model union.
// enter/leave/walkAway/shelfClose carry no data; verify/pay nest a pass/fail
// result, scanQR a result + sku, walkToShelf a shelfId, inspectItem a
// keep/return result.
export type ActionInput =
  | { action: "enter" }
  | { action: "leave" }
  | { action: "walkAway" }
  | { action: "shelfClose" }
  | { action: "verify"; payload: { result: "pass" | "fail"; imageURL?: string } }
  | { action: "pay"; payload: { result: "pass" | "fail"; imageURL?: string } }
  | { action: "scanQR"; payload: { result: "pass" | "fail"; sku: string } }
  | { action: "walkToShelf"; payload: { shelfId: string } }
  | { action: "inspectItem"; payload: { result: "keep" | "return" } };

// ── external boot roster ──────────────────────────────────────────────
// One row from GET {ATK_STORE_API_URL}/animation-api/users. Only a subset
// maps onto our User; disabled_*/exited_at have no home here.
export type ExternalUser = {
  // lands on User.external_id, NOT User.id — every boot row gets a freshly
  // minted uuid like anyone else (see fetchBootRoster)
  id: number;
  name: string;
  email: string;
  avatar_url: string | null;
  visit_status: string | null;
  // ISO 8601 (or null). Kept only for rows still in the store — on an exited
  // row it's the last visit's start, which would make the dashboard count a
  // days-old timer the moment they walk back in.
  entered_at: string | null;
};
