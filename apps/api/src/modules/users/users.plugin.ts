import { Elysia, sse } from "elysia";
import { usersModel } from "./users.model";
import { usersService, type UserEvent } from "./users.service";

export const usersPlugin = new Elysia({ prefix: "/users", tags: ["users"] })
  .use(usersModel)
  .use(usersService)

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
  //   enter   — outside  → waiting   (queue at the entrance for a verdict)
  //   verify  — waiting  → inside/outside  (payload.result pass/fail)
  //   leave   — inside   → paying    (hurry to the exit fare-gate)
  //   pay     — paying   → outside   (payload.result pass leaves, fail retries)
  // Always responds with the full user entity. A wrong-state move 409s; a bad
  // action/payload combo 422s at validation before the switch runs.
  .post(
    "/:id/status",
    ({ usersService, params, body }) => usersService.applyAction(params.id, body),
    {
      params: "users.params",
      body: "users.action",
      response: "users.entity",
    },
  );
