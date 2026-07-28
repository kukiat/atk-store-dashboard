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
  id: number;
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
  // display-only profile fields (see ../modules/users/users.model.ts)
  email: string;
  avatar_url: string;
  auth_method: AuthMethod;
};
export type UserEvent =
  | { type: "added" | "updated" | "enter"; user: User }
  | { type: "removed" | "leave" | "walkAway" | "shelfClose"; user: { id: number } }
  // verify carries an optional, transient imageURL (the face photo to flash on
  // a pass) — it rides the event only, never lands on the stored User.
  | {
    type: "verify" | "pay";
    user: { id: number; result: "pass" | "fail"; imageURL?: string };
  }
  // scanQR carries the scanned sku too, so the feed reflects what was scanned
  | { type: "scanQR"; user: { id: number; result: "pass" | "fail"; sku: string } }
  | { type: "walkToShelf"; user: { id: number; shelfId: string } }
  | { type: "inspectItem"; user: { id: number; result: "keep" | "return" } };

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
