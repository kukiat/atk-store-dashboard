import { Elysia, status } from "elysia";

// In-memory stand-in for the future external users API — no DB on purpose.
// State lives and dies with the process; the boot roster is fetched once at
// startup from the external animation-api (see fetchBootRoster below), then
// this store owns every mutation from there on.
// The API owns each customer's lifecycle: the 3D sim never walks a roster
// customer out on its own, so `status` here is authoritative.
//   outside --enter--> waiting --verify pass--> inside --leave--> paying
//                        '--verify fail--> outside      --pay pass--> outside
//                                                       '--pay fail--> paying (retry)
// Leave no longer exits the store: it sends the shopper to queue at the
// exit fare-gate (paying); a face-scan pay (pass) releases them outside,
// a fail keeps them at the gate to try again — the exit-side mirror of the
// entrance enter/verify flow.
// All four status moves enter through one route — POST /:id/status with a
// { action, payload? } body — which the service fans out via applyAction's
// switch. The distinct per-transition SSE events (enter/verify/leave/pay)
// are unchanged: only the HTTP surface collapsed, not the feed.
// `verify` doubles as the one-shot entrance: called from `outside` it runs the
// enter step itself (emitting `enter`) before the verdict (emitting `verify`),
// so a single call takes a customer from the street to inside/turned-away.
// `enter` stays a standalone action for parking someone at the gate first.
// `pay` mirrors this on the exit: from inside/scanning/browsing it runs the
// leave step (emitting `leave`) before the verdict (emitting `pay`), so one
// call takes a shopper from the floor to out (pass) or stuck at the gate
// (fail). `leave` stays standalone for parking someone at the fare-gate first.
// `scanQR` does the same on the shelf sub-machine: from `inside` it runs the
// walkToShelf step (to the shelf its `sku` resolves to, emitting `walkToShelf`)
// before the scan verdict (emitting `scanQR`). `walkToShelf` stays standalone.
// POST /users is "roster entry + auto-enter" in one call: a freshly created
// user starts `waiting` (holding at the entrance scanner for a verify verdict),
// the same place an `enter` action lands them — not walking straight in.
// The boot roster is the exception: those users start at the status mapped
// from the external feed's `visit_status` (inside/outside), the start crowd.
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
  shelf_id: number | null;
  // display-only profile fields (see users.model.ts)
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
  | { type: "walkToShelf"; user: { id: number; shelfId: number } }
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
  | { action: "pay"; payload: { result: "pass" | "fail" } }
  | { action: "scanQR"; payload: { result: "pass" | "fail"; sku: string } }
  | { action: "walkToShelf"; payload: { shelfId: number } }
  | { action: "inspectItem"; payload: { result: "keep" | "return" } };

// ── external boot roster ──────────────────────────────────────────────
// One row from GET {ATK_STORE_API_URL}/animation-api/users. Only a subset
// maps onto our User; disabled_*/entered_at/exited_at have no home here.
type ExternalUser = {
  id: number;
  name: string;
  email: string;
  avatar_url: string | null;
  visit_status: string | null;
};

// external `visit_status` → our UserStatus, or null to drop the row.
// exited → outside; a value already a UserStatus passes through as-is;
// null and every unrecognized value are filtered out of the boot roster.
function mapVisitStatus(v: string | null): UserStatus | null {
  switch (v) {
    case "inside":
    case "outside":
    case "waiting":
    case "paying":
      return v;
    case "exited":
      return "outside";
    default:
      return null;
  }
}

// The external feed carries no gender, but the 3D sim needs one to pick a body
// model. Best-effort: match the first name token against a small dictionary;
// when the name gives no signal, fall back to id parity so it's stable per boot.
const FEMALE_NAMES = new Set([
  "mali", "pimchanok", "siriporn", "emma", "olivia",
  "ploy", "fah", "napat", "kanya", "waan",
]);
const MALE_NAMES = new Set([
  "narin", "tanawat", "buncha", "kukiat", "keemmer",
  "james", "liam", "noah", "somchai", "anan",
]);
function guessGender(name: string, id: number): User["gender"] {
  const first = name.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (FEMALE_NAMES.has(first)) return "female";
  if (MALE_NAMES.has(first)) return "male";
  return id % 2 === 0 ? "female" : "male";
}

// Fetch the crowd from external. At module load a failure here rejects the
// top-level await below, which aborts server startup — external must be up.
// Also called at runtime by refreshRoster (Backdoor's reload button), where a
// failure is caught and turned into a 502 instead of killing the process.
async function fetchBootRoster(): Promise<User[]> {
  const url = `${process.env.ATK_STORE_API_URL}/animation-api/users`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      `users boot roster fetch failed: ${res.status} ${res.statusText}`,
    );
  const rows = (await res.json()) as ExternalUser[];
  return rows.flatMap((u) => {
    const status = mapVisitStatus(u.visit_status);
    if (status === null) return []; // drop visit_status null / unrecognized
    const user: User = {
      id: u.id,
      name: u.name,
      gender: guessGender(u.name, u.id),
      status,
      shelf_id: null,
      email: u.email,
      avatar_url: u.avatar_url ?? "", // null → "" (UI falls back to initials)
      auth_method: "google", // external only ever shows Google logins
    };
    return [user];
  });
}

class UsersService {
  private store = new Map<number, User>();
  private nextId = 1;
  private listeners = new Set<(e: UserEvent) => void>();

  constructor(roster: User[]) {
    this.resetRoster(roster);
  }

  // Swap the whole store for a fresh roster — boot and refreshRoster share this.
  private resetRoster(roster: User[]) {
    this.store = new Map(roster.map((u) => [u.id, u]));
    this.nextId = Math.max(0, ...this.store.keys()) + 1;
  }

  // Backdoor's "Reload from External" button: put the store back to the state a
  // fresh boot would leave it in, without restarting. The await lands before
  // anything is touched, so an external failure leaves the store exactly as it
  // was — there is nothing to roll back.
  async refreshRoster() {
    const roster = await fetchBootRoster();
    // Every current body is dropped and none are re-announced: to the scene
    // `added` means "walk in the front door and hold for verify" (it ignores
    // status), so replaying the new roster would march `outside` users inside
    // and wedge them at the scanner. The scene has no SSE vocabulary for
    // reseeding a roster — it seeds from GET /users at construction, so the
    // fresh crowd shows up on the next dashboard reload.
    const gone = [...this.store.keys()];
    this.resetRoster(roster);
    for (const id of gone) this.emit({ type: "removed", user: { id } });
    return this.list();
  }

  // event hub — the SSE route subscribes, mutations broadcast
  subscribe(fn: (e: UserEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: UserEvent) {
    for (const fn of this.listeners) fn(e);
  }

  private mustFind(id: number) {
    const user = this.store.get(id);
    if (!user) throw status(404, "User not found");
    return user;
  }

  list() {
    return [...this.store.values()];
  }

  findById(id: number) {
    return this.mustFind(id);
  }

  create(input: {
    name: string;
    gender: User["gender"];
    email?: string;
    avatar_url?: string;
    auth_method?: AuthMethod;
  }) {
    // land at the entrance queue for a verify verdict, like enter —
    // the scene spawns `added` users holding at the gate, not walking in
    const id = this.nextId++;
    const user: User = {
      id,
      name: input.name,
      gender: input.gender,
      status: "waiting",
      shelf_id: null,
      // defaults filled here (after id) so a bare {name,gender} POST works
      email: input.email ?? `user${id}@demo.local`,
      avatar_url: input.avatar_url ?? "",
      auth_method: input.auth_method ?? "google",
    };
    this.store.set(user.id, user);
    this.emit({ type: "added", user });
    return user;
  }

  update(
    id: number,
    input: Partial<
      Pick<User, "name" | "gender" | "email" | "avatar_url" | "auth_method">
    >,
  ) {
    const user = this.mustFind(id);
    Object.assign(user, input);
    this.emit({ type: "updated", user });
    return user;
  }

  remove(id: number) {
    if (!this.store.delete(id)) throw status(404, "User not found");
    this.emit({ type: "removed", user: { id } });
    return { id };
  }

  // wipe a shelf session off the entity (does NOT emit — callers own that)
  private endShelfSession(user: User) {
    user.shelf_id = null;
  }

  // The four status transitions all enter through one door now: POST
  // /:id/status → applyAction, which switches on `action` and delegates to the
  // matching step below. The steps stay private (guard + emit each own their
  // slice) so the switch is the only public entry and the SSE contract — one
  // distinct event per transition — is untouched.
  // scanQR needs the shelf its sku resolves to; the route owns the shelfs
  // service, so it does the findBySku (+ online/checkout gating) and hands the
  // resolved shelf id in here. Every other action ignores it.
  applyAction(id: number, input: ActionInput, skuShelfId?: number): User {
    switch (input.action) {
      case "enter":
        return this.enter(id);
      case "verify":
        return this.verify(id, input.payload.result, input.payload.imageURL);
      case "leave":
        return this.leave(id);
      case "pay":
        return this.pay(id, input.payload.result);
      case "walkToShelf":
        return this.walkToShelf(id, input.payload.shelfId);
      case "scanQR":
        return this.scanQR(id, input.payload.result, input.payload.sku, skuShelfId!);
      case "inspectItem":
        return this.inspectItem(id, input.payload.result);
      case "walkAway":
        return this.walkAway(id);
      case "shelfClose":
        return this.shelfClose(id);
      default: {
        // the model union already rejects unknown actions at validation;
        // this is a defensive backstop that also gives TS exhaustiveness
        const _never: never = input;
        throw status(422, `Unknown action`);
      }
    }
  }

  // walk up to the entrance and wait in line for a verify verdict
  private enter(id: number) {
    const user = this.mustFind(id);
    if (user.status !== "outside")
      throw status(409, `User is ${user.status}, enter needs "outside"`);
    user.status = "waiting";
    this.emit({ type: "enter", user });
    return user;
  }

  // verdict for someone at the gate: pass walks them in, fail turns them away
  // (they must enter again). Accepts `outside` too — there it first runs the
  // enter step (outside → waiting, emits `enter`), then the verdict, so one
  // call brings a customer from the street to inside/turned-away. The two SSE
  // events still fire in order (enter then verify): the feed stays per-step,
  // only the HTTP surface collapses. A `fail` from outside is a no-op round
  // trip (outside → waiting → outside) that reads as "rejected at the door".
  private verify(id: number, result: "pass" | "fail", imageURL?: string) {
    const user = this.mustFind(id);
    if (user.status !== "waiting" && user.status !== "outside")
      throw status(
        409,
        `User is ${user.status}, verify needs "waiting" or "outside"`,
      );
    if (user.status === "outside") this.enter(id); // → waiting, emits `enter`
    user.status = result === "pass" ? "inside" : "outside";
    // imageURL rides the event untouched (undefined drops out of the JSON) —
    // the dashboard flashes it only on a pass; the store never keeps it.
    this.emit({ type: "verify", user: { id, result, imageURL } });
    return user;
  }

  // command to the store — drop everything, hurry to the exit gate, and
  // hold there to pay. Does NOT leave the store yet (that's pay pass).
  // Highest-authority move: it also cuts through a live shelf session
  // (scanning/browsing) — an item still in hand counts as taken.
  // Returns the full user (the /status route responds with the entity for
  // every action); the SSE `leave` event still carries just { id }.
  private leave(id: number) {
    const user = this.mustFind(id);
    if (
      user.status !== "inside" &&
      user.status !== "scanning" &&
      user.status !== "browsing"
    )
      throw status(
        409,
        `User is ${user.status}, leave needs "inside", "scanning" or "browsing"`,
      );
    this.endShelfSession(user);
    user.status = "paying";
    this.emit({ type: "leave", user: { id } });
    return user;
  }

  // ---- shelf sub-machine (inside ⇄ scanning → browsing → inside) ----
  // The shelf's existence/online checks live in the route (it has the shelfs
  // service); here we only own the user-status side of the transition.

  // walk up to the shelf and hold there for a scanQR verdict — no self-scan,
  // the shelf-side mirror of enter/waiting
  private walkToShelf(id: number, shelfId: number) {
    const user = this.mustFind(id);
    if (user.status !== "inside")
      throw status(409, `User is ${user.status}, walkToShelf needs "inside"`);
    user.status = "scanning";
    user.shelf_id = shelfId;
    this.emit({ type: "walkToShelf", user: { id, shelfId } });
    return user;
  }

  // verdict for someone at the shelf reader: pass opens the glass and arms the
  // 30s browse timer, fail keeps them at the reader to rescan. Accepts `inside`
  // too — there it first runs the walkToShelf step to the sku's shelf (emits
  // `walkToShelf`), then the verdict, so one call takes a shopper from the
  // floor to browsing (pass) or holding at the reader (fail; net inside →
  // scanning, not a round trip). `targetShelfId` is the sku's shelf, resolved
  // by the route. From `scanning` the sku must name the shelf they already
  // stand at — a mismatch is rejected rather than silently walking them off.
  // `walkToShelf` stays standalone for parking someone at a reader first.
  private scanQR(
    id: number,
    result: "pass" | "fail",
    sku: string,
    targetShelfId: number,
  ) {
    const user = this.mustFind(id);
    if (user.status !== "scanning" && user.status !== "inside")
      throw status(
        409,
        `User is ${user.status}, scanQR needs "inside" or "scanning"`,
      );
    if (user.status === "inside") {
      this.walkToShelf(id, targetShelfId); // → scanning, emits `walkToShelf`
    } else if (user.shelf_id !== targetShelfId) {
      throw status(
        409,
        `User is at shelf ${user.shelf_id}, but sku ${sku} belongs to shelf ${targetShelfId}`,
      );
    }
    if (result === "pass") user.status = "browsing"; // held open until shelfClose/leave
    this.emit({ type: "scanQR", user: { id, result, sku } });
    return user;
  }

  // one full pick cycle per request: keep pockets the item (paid at the exit),
  // return puts it back on the shelf. Status doesn't move.
  private inspectItem(id: number, result: "keep" | "return") {
    const user = this.mustFind(id);
    if (user.status !== "browsing")
      throw status(409, `User is ${user.status}, inspectItem needs "browsing"`);
    this.emit({ type: "inspectItem", user: { id, result } });
    return user;
  }

  // give up waiting for a verdict and rejoin the loop. Only valid while
  // scanning — an open session (browsing) ends via shelfClose or leave.
  private walkAway(id: number) {
    const user = this.mustFind(id);
    if (user.status !== "scanning")
      throw status(409, `User is ${user.status}, walkAway needs "scanning"`);
    this.endShelfSession(user);
    user.status = "inside";
    this.emit({ type: "walkAway", user: { id } });
    return user;
  }

  // done browsing: close the door and drop back to inside (the scene mirrors it
  // via SSE). The browse session has no auto-close timer — it holds open until
  // this action (or leave) fires. Only valid while browsing; scanning bails via
  // walkAway instead.
  private shelfClose(id: number) {
    const user = this.mustFind(id);
    if (user.status !== "browsing")
      throw status(409, `User is ${user.status}, shelfClose needs "browsing"`);
    this.endShelfSession(user);
    user.status = "inside";
    this.emit({ type: "shelfClose", user: { id } });
    return user;
  }

  // face-scan at the exit fare-gate for someone holding there (paying):
  // pass walks them out of the store, fail keeps them at the gate to retry.
  // Accepts `inside`/`scanning`/`browsing` too — there it first runs the leave
  // step (→ paying, emits `leave`), then the verdict, so one call takes a
  // shopper from the floor to out/stuck-at-the-gate. The two SSE events still
  // fire in order (leave then pay): the feed stays per-step, only the HTTP
  // surface collapses — the exit-side mirror of verify rolling in enter.
  // Unlike verify's fail (a no-op round trip), a `fail` here still moved the
  // shopper to the gate: net inside → paying, holding to retry.
  private pay(id: number, result: "pass" | "fail") {
    const user = this.mustFind(id);
    if (
      user.status !== "paying" &&
      user.status !== "inside" &&
      user.status !== "scanning" &&
      user.status !== "browsing"
    )
      throw status(
        409,
        `User is ${user.status}, pay needs "paying", "inside", "scanning" or "browsing"`,
      );
    if (user.status !== "paying") this.leave(id); // → paying, emits `leave`
    if (result === "pass") user.status = "outside";
    this.emit({ type: "pay", user: { id, result } });
    return user;
  }
}

// top-level await: block module load (and thus server startup) until the
// external roster is in hand — see fetchBootRoster's failure note above.
const bootRoster = await fetchBootRoster();

export const usersService = new Elysia({ name: "users.service" }).decorate(
  "usersService",
  new UsersService(bootRoster),
);
