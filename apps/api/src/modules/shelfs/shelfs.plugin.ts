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
  })

  .post(
    "/",
    ({ shelfsService, body, set }) => {
      set.status = 201;
      return shelfsService.create(body);
    },
    {
      body: "shelfs.create",
      response: { 201: "shelfs.entity" },
    },
  )

  .patch(
    "/:id",
    ({ shelfsService, params, body }) => shelfsService.update(params.id, body),
    {
      params: "shelfs.params",
      body: "shelfs.update",
      response: "shelfs.entity",
    },
  )

  .delete("/:id", ({ shelfsService, params }) => shelfsService.softDelete(params.id), {
    params: "shelfs.params",
    response: "shelfs.deleted",
  });
