import { Elysia, sse } from "elysia";
import { crowdModel } from "./crowd.model";
import { crowdService } from "./crowd.service";
import type { CrowdEvent } from "../../models";
import { ok, envelopeError } from "../../envelope";

export const crowdPlugin = new Elysia({ prefix: "/crowd", tags: ["crowd"] })
  .use(crowdModel)
  .use(crowdService)
  .onError(envelopeError)

  // Live feed for the 3D dashboard: every target change broadcasts here so the
  // scene can reconcile its random population. Separate stream from /users/events
  // on purpose — random shoppers are a scalar, not roster members.
  .get("/events", async function* ({ request, crowdService }) {
    const queue: CrowdEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = crowdService.subscribe((e) => {
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
          yield sse({ event: e.type, data: { target: e.target } });
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

  .get("/", ({ crowdService }) => ok(crowdService.get()), {
    response: "crowd.res.entity",
  })

  // absolute set (Backdoor holds the current value and PATCHes the new one)
  .patch("/", ({ crowdService, body }) => ok(crowdService.set(body.target)), {
    body: "crowd.set",
    response: "crowd.res.entity",
  });
