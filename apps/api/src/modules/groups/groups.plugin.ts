import { Elysia } from "elysia";
import { groupsModel } from "./groups.model";
import { groupsService } from "./groups.service";
import { ok, envelopeError } from "../../envelope";

/**
 * Groups controller. Composes the reference models and the DI service, then
 * declares the HTTP routes. Handlers stay thin — they only wire request data
 * into service calls; validation and error mapping live in the model/service.
 * Service methods are async (DB-backed), so ok() wraps the awaited result.
 */
export const groupsPlugin = new Elysia({ prefix: "/groups", tags: ["groups"] })
  .use(groupsModel)
  .use(groupsService)
  .onError(envelopeError)

  .get("/", async ({ groupsService }) => ok(await groupsService.list()), {
    response: "groups.res.list",
  })

  .get(
    "/:id",
    async ({ groupsService, params }) =>
      ok(await groupsService.findById(params.id)),
    {
      params: "groups.params",
      response: "groups.res.entity",
    },
  )

  .post(
    "/",
    async ({ groupsService, body, set }) => {
      set.status = 201;
      return ok(await groupsService.create(body));
    },
    {
      body: "groups.create",
      response: { 201: "groups.res.entity" },
    },
  )

  .patch(
    "/:id",
    async ({ groupsService, params, body }) =>
      ok(await groupsService.update(params.id, body)),
    {
      params: "groups.params",
      body: "groups.update",
      response: "groups.res.entity",
    },
  )

  .delete(
    "/:id",
    async ({ groupsService, params }) =>
      ok(await groupsService.softDelete(params.id)),
    {
      params: "groups.params",
      response: "groups.res.deleted",
    },
  );
