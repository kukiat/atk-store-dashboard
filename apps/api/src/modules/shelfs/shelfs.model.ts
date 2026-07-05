import { Elysia, t } from "elysia";

/**
 * Public shape of a shelf. `deleted_at` is intentionally omitted.
 */
const ShelfEntity = t.Object({
  id: t.String({ format: "uuid" }),
  groupId: t.Nullable(t.String({ format: "uuid" })),
  name: t.String(),
  imageUrl: t.Nullable(t.String()),
  sensorId: t.Nullable(t.String()),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
});

export const shelfsModel = new Elysia({ name: "shelfs.model" }).model({
  "shelfs.params": t.Object({ id: t.String({ format: "uuid" }) }),
  "shelfs.create": t.Object({
    name: t.String({ minLength: 1 }),
    groupId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
    imageUrl: t.Optional(t.Nullable(t.String())),
    sensorId: t.Optional(t.Nullable(t.String())),
  }),
  // PATCH — every field optional
  "shelfs.update": t.Object({
    name: t.Optional(t.String({ minLength: 1 })),
    groupId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
    imageUrl: t.Optional(t.Nullable(t.String())),
    sensorId: t.Optional(t.Nullable(t.String())),
  }),
  "shelfs.entity": ShelfEntity,
  "shelfs.list": t.Array(ShelfEntity),
  "shelfs.deleted": t.Object({
    id: t.String({ format: "uuid" }),
    deleted: t.Boolean(),
  }),
});
