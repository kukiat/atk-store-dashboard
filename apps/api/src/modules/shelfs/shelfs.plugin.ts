import { Elysia, sse } from "elysia";
import { shelfsModel } from "./shelfs.model";
import { shelfsService } from "./shelfs.service";
import type { ShelfEvent } from "../../models";
import { ok, envelopeError } from "../../envelope";

export const shelfsPlugin = new Elysia({ prefix: "/shelfs", tags: ["shelfs"] })
  .use(shelfsModel)
  .use(shelfsService)
  .onError(envelopeError)

  // Live feed of shelf state changes (both MQTT-driven, deduped to real
  // changes): `online` (status heartbeat → amber LED + locked doors ⇄ scannable
  // in the scene) and `stock` (pick/return currentQty → the dashboard's live
  // stock). Declared before /:id so the path isn't captured as an id.
  .get("/events", async function* ({ request, shelfsService }) {
    const queue: ShelfEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = shelfsService.subscribe((e) => {
      queue.push(e);
      wake?.();
    });
    const onAbort = () => wake?.();
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      yield sse({ event: "hello", data: { connected: true } });
      while (!request.signal.aborted) {
        while (queue.length) {
          const { type, ...data } = queue.shift()!; // data = the event minus its discriminator
          yield sse({ event: type, data });
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

  .get("/", async ({ shelfsService }) => ok(await shelfsService.list()), {
    response: "shelfs.res.list",
  })

  .get(
    "/:id",
    async ({ shelfsService, params }) => ok(await shelfsService.findById(params.id)),
    {
      params: "shelfs.params",
      response: "shelfs.res.entity",
    },
  );
