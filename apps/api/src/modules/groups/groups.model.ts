import { Elysia, t } from "elysia";

/**
 * Public shape of a group returned to clients.
 * Note: `deleted_at` is intentionally omitted (internal soft-delete marker).
 */
const GroupEntity = t.Object({
  id: t.String({ format: "uuid" }),
  name: t.String(),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
});

export const groupsModel = new Elysia({ name: "groups.model" }).model({
  "groups.params": t.Object({ id: t.String({ format: "uuid" }) }),
  "groups.create": t.Object({ name: t.String({ minLength: 1 }) }),
  "groups.update": t.Object({ name: t.String({ minLength: 1 }) }),
  "groups.entity": GroupEntity,
  "groups.list": t.Array(GroupEntity),
  "groups.deleted": t.Object({
    id: t.String({ format: "uuid" }),
    deleted: t.Boolean(),
  }),
});
