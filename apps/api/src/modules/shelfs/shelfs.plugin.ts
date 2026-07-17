import { Elysia } from "elysia";
import { shelfsModel } from "./shelfs.model";
import { shelfsService } from "./shelfs.service";
import { ok, envelopeError } from "../../envelope";

export const shelfsPlugin = new Elysia({ prefix: "/shelfs", tags: ["shelfs"] })
  .use(shelfsModel)
  .use(shelfsService)
  .onError(envelopeError)

  .get("/", ({ shelfsService }) => ok(shelfsService.list()), {
    response: "shelfs.res.list",
  })

  .get(
    "/:id",
    ({ shelfsService, params }) => ok(shelfsService.findById(params.id)),
    {
      params: "shelfs.params",
      response: "shelfs.res.entity",
    },
  );
