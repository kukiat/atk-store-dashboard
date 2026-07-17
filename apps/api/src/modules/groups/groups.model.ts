import { Elysia, t } from "elysia";
import { envelope } from "../../envelope";

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
  // success-response envelopes (see ../../envelope). DELETE returns just the id
  // (dropped `deleted: true` — see users.model for the rationale).
  "groups.res.entity": envelope(GroupEntity),
  "groups.res.list": envelope(t.Array(GroupEntity)),
  "groups.res.deleted": envelope(
    t.Object({ id: t.String({ format: "uuid" }) }),
  ),
});
