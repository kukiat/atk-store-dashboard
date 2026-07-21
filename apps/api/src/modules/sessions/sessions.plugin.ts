import { Elysia, sse, status } from "elysia";
import { sessionsModel } from "./sessions.model";
import { sessionsService } from "./sessions.service";
import { usersService } from "../users";
import type { SessionEvent } from "../../models";
import { ok, envelopeError } from "../../envelope";

export const sessionsPlugin = new Elysia({ prefix: "/sessions", tags: ["sessions"] })
  .use(sessionsModel)
  .use(sessionsService)
  .use(usersService) // force-close delegates the teardown to the shelfClose action
  .onError(envelopeError)

  // Live feed of shelf-scan sessions: `opened` when a scanQR passes, `closed`
  // when the browse session ends (shelfClose/leave/walkAway) or the shelf
  // hardware publishes shelf_close over MQTT. Declared before /:id so the path
  // isn't captured as an id.
  .get("/events", async function* ({ request, sessionsService }) {
    const queue: SessionEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = sessionsService.subscribe((e) => {
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
          yield sse({ event: e.type, data: e.session });
        }
        // keepalive: Bun closes idle streams (~10s); ping keeps the pipe warm
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

  .get("/", ({ sessionsService }) => ok(sessionsService.list()), {
    response: "sessions.res.list",
  })

  // Operator force-close (the Backdoor's counterpart to the shelf hardware's
  // MQTT shelf_close): resolve the session → its shopper → run the shelfClose
  // action, which moves them browsing → inside, emits the users SSE, and — via
  // endShelfSession → closeByUser — removes this row (emitting `closed`). We
  // don't delete the row here directly, so both close paths share one teardown.
  .delete(
    "/:id",
    ({ sessionsService, usersService, params }) => {
      const session = sessionsService.get(params.id);
      if (!session) throw status(404, "Session not found");
      usersService.applyAction(session.userId, { action: "shelfClose" });
      return ok({ id: session.id });
    },
    {
      params: "sessions.params",
      response: "sessions.res.deleted",
    },
  );
