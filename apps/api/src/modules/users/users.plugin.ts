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
  //   verify      — waiting  → inside/outside  (payload.result pass/fail)
  //   walkToShelf — inside   → scanning  (hold at the shelf reader for a verdict)
  //   scanQR      — inside/scanning → browsing (pass) / scanning (fail); from
  //                 inside it walks to the sku's shelf first
  //   inspectItem — browsing → browsing  (one pick: keep or return)
  //   walkAway    — scanning → inside    (give up waiting, rejoin the loop)
  //   shelfClose  — browsing → inside    (done browsing, close the door)
  //   leave       — inside/scanning/browsing → paying (drops any shelf session)
  //   pay         — paying   → outside   (payload.result pass leaves, fail retries)
  // Always responds with the full user entity. A wrong-state move 409s; a bad
  // action/payload combo 422s at validation before the switch runs. The browse
  // session has no auto-close timer — it holds open until shelfClose (or leave).
  .post(
    "/:id/status",
    ({ usersService, shelfsService, params, body }) => {
      // a shelf command must target a shelf with doors: exists (404), powered
      // (409), and not a checkout counter (409) — the shelfs service owns the
      // layout, users only the people. walkToShelf names the shelf by id;
      // scanQR names it by sku (resolved 1:1), and the resolved id is handed to
      // the service so it knows where to walk the shopper.
      const assertHasDoors = (shelf: { id: number; online: boolean; type: string }) => {
        if (!shelf.online)
          throw status(409, `Shelf ${shelf.id} is offline, doors never unlock`);
        if (shelf.type === "checkout")
          throw status(409, `Shelf ${shelf.id} is a checkout counter — no doors`);
      };
      let skuShelfId: number | undefined;
      if (body.action === "walkToShelf") {
        assertHasDoors(shelfsService.findById(body.payload.shelfId));
      } else if (body.action === "scanQR") {
        const shelf = shelfsService.findBySku(body.payload.sku); // 404 if unknown
        assertHasDoors(shelf);
        skuShelfId = shelf.id;
      }
      return ok(usersService.applyAction(params.id, body, skuShelfId));
    },
    {
      params: "users.params",
      body: "users.action",
      response: "users.res.entity",
    },
  );
