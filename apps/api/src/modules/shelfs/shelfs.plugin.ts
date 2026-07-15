import { Elysia } from "elysia";
import { shelfsModel } from "./shelfs.model";
import { shelfsService } from "./shelfs.service";

export const shelfsPlugin = new Elysia({ prefix: "/shelfs", tags: ["shelfs"] })
  .use(shelfsModel)
  .use(shelfsService)

  .get("/", ({ shelfsService }) => shelfsService.list(), {
    response: "shelfs.list",
  })

  .get("/:id", ({ shelfsService, params }) => shelfsService.findById(params.id), {
    params: "shelfs.params",
    response: "shelfs.entity",
  });
