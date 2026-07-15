import { Elysia, t } from "elysia";

// A single stock line on a shelf — qty/reorder are the live-stock starting values.
const ShelfItem = t.Object({
  id: t.String(),
  name: t.String(),
  color: t.String(),
  capacity: t.Number(),
  qty: t.Number(),
  reorder: t.Number(),
});

/**
 * Public shape of a shelf — a passthrough of the mock store layout
 * (geometry + stock), served read-only from seed.json.
 */
const ShelfEntity = t.Object({
  id: t.Number(),
  name: t.String(),
  type: t.Union([t.Literal("wall"), t.Literal("gondola"), t.Literal("checkout")]),
  x: t.Number(),
  z: t.Number(),
  rotation: t.Number(),
  length: t.Number(),
  online: t.Boolean(),
  items: t.Array(ShelfItem),
});

export const shelfsModel = new Elysia({ name: "shelfs.model" }).model({
  "shelfs.params": t.Object({ id: t.Number() }),
  "shelfs.entity": ShelfEntity,
  "shelfs.list": t.Array(ShelfEntity),
});
