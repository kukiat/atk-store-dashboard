import { Elysia, t } from "elysia";
import { envelope } from "../../envelope";

// A single stock line on a shelf — qty/reorder are the live-stock starting values.
const ShelfItem = t.Object({
  id: t.String(),
  name: t.String(),
  color: t.String(),
  capacity: t.Number(),
  qty: t.Number(),
  reorder: t.Number(),
  // per-unit product weight in kg (from the loadcell device's product record)
  weight: t.Number(),
});

/**
 * Public shape of a shelf — a passthrough of the mock store layout
 * (geometry + stock), served read-only from seed.json.
 */
const ShelfEntity = t.Object({
  // device_id string from the IoT feed (e.g. "10005" / "BF67EC")
  id: t.String(),
  name: t.String(),
  // scanQR sku — users API resolves it to a shelf via findBySku (not unique in
  // the IoT feed, so it resolves to the first match)
  sku: t.String(),
  type: t.Union([t.Literal("wall"), t.Literal("gondola"), t.Literal("checkout")]),
  x: t.Number(),
  z: t.Number(),
  rotation: t.Number(),
  length: t.Number(),
  online: t.Boolean(),
  items: t.Array(ShelfItem),
});

export const shelfsModel = new Elysia({ name: "shelfs.model" }).model({
  "shelfs.params": t.Object({ id: t.String() }),
  "shelfs.entity": ShelfEntity,
  "shelfs.list": t.Array(ShelfEntity),
  // success-response envelopes (see ../../envelope)
  "shelfs.res.entity": envelope(ShelfEntity),
  "shelfs.res.list": envelope(t.Array(ShelfEntity)),
});
