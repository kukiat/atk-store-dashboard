import { Elysia } from "elysia";
import { groupsModel } from "./groups.model";
import { groupsService } from "./groups.service";

/**
 * Groups controller. Composes the reference models and the DI service, then
 * declares the HTTP routes. Handlers stay thin — they only wire request data
 * into service calls; validation and error mapping live in the model/service.
 */
export const groupsPlugin = new Elysia({ prefix: "/groups", tags: ["groups"] })
  .use(groupsModel)
  .use(groupsService)

  .get("/", ({ groupsService }) => groupsService.list(), {
    response: "groups.list",
  })

  .get("/:id", ({ groupsService, params }) => groupsService.findById(params.id), {
    params: "groups.params",
    response: "groups.entity",
  })

  .post(
    "/",
    ({ groupsService, body, set }) => {
      set.status = 201;
      return groupsService.create(body);
    },
    {
      body: "groups.create",
      response: { 201: "groups.entity" },
    },
  )

  .patch(
    "/:id",
    ({ groupsService, params, body }) => groupsService.update(params.id, body),
    {
      params: "groups.params",
      body: "groups.update",
      response: "groups.entity",
    },
  )

  .delete("/:id", ({ groupsService, params }) => groupsService.softDelete(params.id), {
    params: "groups.params",
    response: "groups.deleted",
  });
