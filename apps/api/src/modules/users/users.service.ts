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
// POST /users is "roster entry + auto-enter" in one call: a freshly created
// user starts `waiting` (holding at the entrance scanner for a verify verdict),
// the same place an `enter` action lands them — not walking straight in.
// The boot roster is the exception: those users start at the status mapped
// from the external feed's `visit_status` (inside/outside), the start crowd.
export type UserStatus = "outside" | "waiting" | "inside" | "paying";
export type AuthMethod = "google" | "outlook" | "facebook";
export type User = {
  id: number;
  name: string;
  gender: "male" | "female";
  status: UserStatus;
  // display-only profile fields (see users.model.ts)
  email: string;
  avatar_url: string;
  auth_method: AuthMethod;
};
export type UserEvent =
  | { type: "added" | "updated" | "enter"; user: User }
  | { type: "removed" | "leave"; user: { id: number } }
  | {
      type: "verify" | "pay";
      user: { id: number; result: "pass" | "fail" };
    };

// body of POST /:id/status — mirror of the "users.action" model union.
// enter/leave carry no data; verify/pay nest a pass/fail result.
export type ActionInput =
  | { action: "enter" }
  | { action: "leave" }
  | { action: "verify"; payload: { result: "pass" | "fail" } }
  | { action: "pay"; payload: { result: "pass" | "fail" } };

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

// Fetch the starting crowd once at module load. A failure here rejects the
// top-level await below, which aborts server startup — external must be up.
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
      email: u.email,
      avatar_url: u.avatar_url ?? "", // null → "" (UI falls back to initials)
      auth_method: "google", // external only ever shows Google logins
    };
    return [user];
  });
}

class UsersService {
  private store: Map<number, User>;
  private nextId: number;
  private listeners = new Set<(e: UserEvent) => void>();

  constructor(roster: User[]) {
    this.store = new Map(roster.map((u) => [u.id, u]));
    this.nextId = Math.max(0, ...this.store.keys()) + 1;
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
    return { id, deleted: true as const };
  }

  // The four status transitions all enter through one door now: POST
  // /:id/status → applyAction, which switches on `action` and delegates to the
  // matching step below. The steps stay private (guard + emit each own their
  // slice) so the switch is the only public entry and the SSE contract — one
  // distinct event per transition — is untouched.
  applyAction(id: number, input: ActionInput): User {
    switch (input.action) {
      case "enter":
        return this.enter(id);
      case "verify":
        return this.verify(id, input.payload.result);
      case "leave":
        return this.leave(id);
      case "pay":
        return this.pay(id, input.payload.result);
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

  // verdict for someone waiting at the gate: pass walks them in,
  // fail turns them away (they must enter again)
  private verify(id: number, result: "pass" | "fail") {
    const user = this.mustFind(id);
    if (user.status !== "waiting")
      throw status(409, `User is ${user.status}, verify needs "waiting"`);
    user.status = result === "pass" ? "inside" : "outside";
    this.emit({ type: "verify", user: { id, result } });
    return user;
  }

  // command to the store — drop everything, hurry to the exit gate, and
  // hold there to pay. Does NOT leave the store yet (that's pay pass).
  // Returns the full user (the /status route responds with the entity for
  // every action); the SSE `leave` event still carries just { id }.
  private leave(id: number) {
    const user = this.mustFind(id);
    if (user.status !== "inside")
      throw status(409, `User is ${user.status}, leave needs "inside"`);
    user.status = "paying";
    this.emit({ type: "leave", user: { id } });
    return user;
  }

  // face-scan at the exit fare-gate for someone holding there (paying):
  // pass walks them out of the store, fail keeps them at the gate to retry
  private pay(id: number, result: "pass" | "fail") {
    const user = this.mustFind(id);
    if (user.status !== "paying")
      throw status(409, `User is ${user.status}, pay needs "paying"`);
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
