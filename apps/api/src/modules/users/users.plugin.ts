import { Elysia, sse, status } from "elysia";
import { usersModel } from "./users.model";
import { usersService, type UserEvent } from "./users.service";
import { shelfsService } from "../shelfs";

export const usersPlugin = new Elysia({ prefix: "/users", tags: ["users"] })
  .use(usersModel)
  .use(usersService)
  .use(shelfsService)

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

  .get("/", ({ usersService }) => usersService.list(), {
    response: "users.list",
  })

  .get("/:id", ({ usersService, params }) => usersService.findById(params.id), {
    params: "users.params",
    response: "users.entity",
  })

  .post(
    "/",
    ({ usersService, body, set }) => {
      set.status = 201;
      return usersService.create(body);
    },
    {
      body: "users.create",
      response: { 201: "users.entity" },
    },
  )

  .patch(
    "/:id",
    ({ usersService, params, body }) => usersService.update(params.id, body),
    {
      params: "users.params",
      body: "users.update",
      response: "users.entity",
    },
  )

  .delete("/:id", ({ usersService, params }) => usersService.remove(params.id), {
    params: "users.params",
    response: "users.deleted",
  })

  // single status-transition endpoint. The { action, payload? } body is a
  // discriminated union (users.action); the service switches on `action`:
  //   enter       — outside  → waiting   (queue at the entrance for a verdict)
  //   verify      — waiting  → inside/outside  (payload.result pass/fail)
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
      return usersService.applyAction(params.id, body);
    },
    {
      params: "users.params",
      body: "users.action",
      response: "users.entity",
    },
  );
