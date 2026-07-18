import { Elysia, sse, status } from "elysia";
import { usersModel } from "./users.model";
import { usersService, type UserEvent } from "./users.service";
import { shelfsService } from "../shelfs";
import { ok, envelopeError } from "../../envelope";

export const usersPlugin = new Elysia({ prefix: "/users", tags: ["users"] })
  .use(usersModel)
  .use(usersService)
  .use(shelfsService)
  // wrap this module's errors (thrown status / validation) in the { data,
  // error, success } envelope. Scoped to /users routes only — the SSE feed is
  // skipped inside envelopeError. Successes are wrapped by ok() in each handler.
  .onError(envelopeError)

  // Live feed for the 3D dashboard: added → walks in through the scan gate,
  // updated → card refresh / body respawn, removed → fades out in place.
  // Declared before /:id so the path doesn't get captured as an id.
  .get("/events", async function* ({ request, usersService }) {
    const queue: UserEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = usersService.subscribe((e) => {
      queue.push(e);
      wake?.();
    });
    const onAbort = () => wake?.();
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      yield sse({ event: "hello", data: { connected: true } });
      while (!request.signal.aborted) {
        while (queue.length) {
          const e = queue.shift()!;
          yield sse({ event: e.type, data: e.user });
        }
        // keepalive: Bun closes streams idle for ~10s, and events emitted
        // while the client reconnects are simply lost — ping keeps the pipe
        // warm so a curl always lands on a live listener
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 8000);
        });
        wake = null;
        if (!request.signal.aborted && queue.length === 0) {
          yield sse({ event: "ping", data: "" });
        }
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  })

  // Re-run the boot roster fetch on demand (the Backdoor's reload button) and
  // replace the store wholesale — every local lifecycle status is thrown away
  // for what external says, exactly as a restart would. Also declared before
  // /:id, whose t.Numeric param would 422 on "roster".
  .post(
    "/roster/refresh",
    async ({ usersService }) => {
      try {
        return ok(await usersService.refreshRoster());
      } catch (e) {
        // upstream is down or erroring. Unlike boot — where the same failure
        // aborts startup on purpose — the store is left untouched here, so this
        // is a plain gateway error the operator can retry.
        throw status(
          502,
          e instanceof Error ? e.message : "roster refresh failed",
        );
      }
    },
    { response: "users.res.list" },
  )

  .get("/", ({ usersService }) => ok(usersService.list()), {
    response: "users.res.list",
  })

  .get(
    "/:id",
    ({ usersService, params }) => ok(usersService.findById(params.id)),
    {
      params: "users.params",
      response: "users.res.entity",
    },
  )

  .post(
    "/",
    ({ usersService, body, set }) => {
      set.status = 201;
      return ok(usersService.create(body));
    },
    {
      body: "users.create",
      response: { 201: "users.res.entity" },
    },
  )

  .patch(
    "/:id",
    ({ usersService, params, body }) => ok(usersService.update(params.id, body)),
    {
      params: "users.params",
      body: "users.update",
      response: "users.res.entity",
    },
  )

  .delete(
    "/:id",
    ({ usersService, params }) => ok(usersService.remove(params.id)),
    {
      params: "users.params",
      response: "users.res.deleted",
    },
  )

  // single status-transition endpoint. The { action, payload? } body is a
  // discriminated union (users.action); the service switches on `action`:
  //   enter       — outside  → waiting   (queue at the entrance for a verdict)
  //   verify      — waiting  → inside/outside  (payload.result pass/fail; optional
  //                 payload.imageURL rides the SSE event for the dash face-flash)
  //   walkToShelf — inside   → scanning  (hold at the shelf reader for a verdict)
  //   scanQR      — scanning → browsing (pass, arms the 30s timer) / stays (fail)
  //   inspectItem — browsing → browsing  (one pick: keep or return)
  //   walkAway    — scanning → inside    (give up waiting, rejoin the loop)
  //   leave       — inside/scanning/browsing → paying (drops any shelf session)
  //   pay         — paying   → outside   (payload.result pass leaves, fail retries)
  // Always responds with the full user entity. A wrong-state move 409s; a bad
  // action/payload combo 422s at validation before the switch runs.
  // shelfClose has no HTTP action — the service's own browse timer fires it.
  .post(
    "/:id/status",
    ({ usersService, shelfsService, params, body }) => {
      // the shelf must exist (404) and be powered (409) before the user-status
      // side runs — the shelfs service owns the layout, users only the people
      if (body.action === "walkToShelf") {
        const shelf = shelfsService.findById(body.payload.shelfId);
        if (!shelf.online)
          throw status(409, `Shelf ${shelf.id} is offline, doors never unlock`);
        if (shelf.type === "checkout")
          throw status(409, `Shelf ${shelf.id} is a checkout counter — no doors`);
      }
      return ok(usersService.applyAction(params.id, body));
    },
    {
      params: "users.params",
      body: "users.action",
      response: "users.res.entity",
    },
  );
