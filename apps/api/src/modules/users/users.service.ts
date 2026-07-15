import { Elysia, status } from "elysia";
import seed from "./seed.json";

// In-memory stand-in for the future external users API — no DB on purpose.
// State lives and dies with the process; seed.json is the boot roster.
// The API owns each customer's lifecycle: the 3D sim never walks a roster
// customer out on its own, so `status` here is authoritative.
//   outside --checkin--> waiting --verify pass--> inside --checkout--> paying
//                          '--verify fail--> outside      --payment pass--> outside
//                                                         '--payment fail--> paying (retry)
// Checkout no longer exits the store: it sends the shopper to queue at the
// exit fare-gate (paying); a face-scan payment (pass) releases them outside,
// a fail keeps them at the gate to try again — the exit-side mirror of the
// entrance checkin/verify flow.
// All four status moves enter through one route — POST /:id/status with a
// { action, payload? } body — which the service fans out via applyAction's
// switch. The distinct per-transition SSE events (checkin/verify/checkout/
// payment) are unchanged: only the HTTP surface collapsed, not the feed.
// POST /users is "roster entry + auto-checkin" in one call: a freshly created
// user starts `waiting` (holding at the entrance scanner for a verify verdict),
// the same place a `checkin` action lands them — not walking straight in.
// The seed roster is the exception (those 5 boot as `inside`, the start crowd).
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
  | { type: "added" | "updated" | "checkin"; user: User }
  | { type: "removed" | "checkout"; user: { id: number } }
  | {
      type: "verify" | "payment";
      user: { id: number; result: "pass" | "fail" };
    };

// body of POST /:id/status — mirror of the "users.action" model union.
// checkin/checkout carry no data; verify/payment nest a pass/fail result.
export type ActionInput =
  | { action: "checkin" }
  | { action: "checkout" }
  | { action: "verify"; payload: { result: "pass" | "fail" } }
  | { action: "payment"; payload: { result: "pass" | "fail" } };

class UsersService {
  private store = new Map<number, User>(
    (seed.users as Omit<User, "status">[]).map((u) => [
      u.id,
      { ...u, status: "inside" as const }, // the seed 5 are the starting crowd
    ]),
  );
  private nextId = Math.max(0, ...this.store.keys()) + 1;
  private listeners = new Set<(e: UserEvent) => void>();

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
    // land at the entrance queue for a verify verdict, like checkin —
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
      case "checkin":
        return this.checkin(id);
      case "verify":
        return this.verify(id, input.payload.result);
      case "checkout":
        return this.checkout(id);
      case "payment":
        return this.payment(id, input.payload.result);
      default: {
        // the model union already rejects unknown actions at validation;
        // this is a defensive backstop that also gives TS exhaustiveness
        const _never: never = input;
        throw status(422, `Unknown action`);
      }
    }
  }

  // walk up to the entrance and wait in line for a verify verdict
  private checkin(id: number) {
    const user = this.mustFind(id);
    if (user.status !== "outside")
      throw status(409, `User is ${user.status}, checkin needs "outside"`);
    user.status = "waiting";
    this.emit({ type: "checkin", user });
    return user;
  }

  // verdict for someone waiting at the gate: pass walks them in,
  // fail turns them away (they must checkin again)
  private verify(id: number, result: "pass" | "fail") {
    const user = this.mustFind(id);
    if (user.status !== "waiting")
      throw status(409, `User is ${user.status}, verify needs "waiting"`);
    user.status = result === "pass" ? "inside" : "outside";
    this.emit({ type: "verify", user: { id, result } });
    return user;
  }

  // command to the store — drop everything, hurry to the exit gate, and
  // hold there to pay. Does NOT leave the store yet (that's payment pass).
  // Returns the full user (the /status route responds with the entity for
  // every action); the SSE `checkout` event still carries just { id }.
  private checkout(id: number) {
    const user = this.mustFind(id);
    if (user.status !== "inside")
      throw status(409, `User is ${user.status}, checkout needs "inside"`);
    user.status = "paying";
    this.emit({ type: "checkout", user: { id } });
    return user;
  }

  // face-scan at the exit fare-gate for someone holding there (paying):
  // pass walks them out of the store, fail keeps them at the gate to retry
  private payment(id: number, result: "pass" | "fail") {
    const user = this.mustFind(id);
    if (user.status !== "paying")
      throw status(409, `User is ${user.status}, payment needs "paying"`);
    if (result === "pass") user.status = "outside";
    this.emit({ type: "payment", user: { id, result } });
    return user;
  }
}

export const usersService = new Elysia({ name: "users.service" }).decorate(
  "usersService",
  new UsersService(),
);
