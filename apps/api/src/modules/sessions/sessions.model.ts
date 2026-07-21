import { Elysia, t } from "elysia";
import { envelope } from "../../envelope";

// Nested shapes carried on a session row. These mirror the Shelf / ExternalDevice
// TypeScript types (../../models) and the shelfs module's own TypeBox — kept
// local so the sessions feed is self-contained and Swagger describes the full
// enriched row rather than an opaque blob.
const ShelfItem = t.Object({
  id: t.String(),
  name: t.String(),
  color: t.String(),
  capacity: t.Number(),
  qty: t.Number(),
  reorder: t.Number(),
  weight: t.Number(),
});

const Shelf = t.Object({
  id: t.String(),
  name: t.String(),
  sku: t.String(),
  type: t.Union([t.Literal("wall"), t.Literal("gondola"), t.Literal("checkout")]),
  x: t.Number(),
  z: t.Number(),
  rotation: t.Number(),
  length: t.Number(),
  online: t.Boolean(),
  items: t.Array(ShelfItem),
});

const ExternalDevice = t.Object({
  id: t.String(),
  device_id: t.String(),
  device_name: t.String(),
  device_type: t.String(),
  status: t.String(),
  enabled: t.Boolean(),
  product: t.Object({
    sku: t.String(),
    item_name: t.String(),
    unit_weight_kg: t.Number(),
    max_qty: t.Number(),
  }),
  position: t.Object({
    x: t.Number(),
    z: t.Number(),
    rotation: t.Number(),
    length: t.Number(),
  }),
});

const SessionEntity = t.Object({
  id: t.String(),
  userId: t.Integer(),
  sku: t.String(),
  shelf: Shelf,
  externalDevice: ExternalDevice,
  // live basket — grows as loadcell pick/return events land (see SessionEvent)
  items: t.Array(
    t.Object({
      sku: t.String(),
      name: t.String(),
      qty: t.Number(),
      unitWeightKg: t.Number(),
    }),
  ),
});

export const sessionsModel = new Elysia({ name: "sessions.model" }).model({
  // force-close targets a session by its uuid
  "sessions.params": t.Object({ id: t.String() }),
  "sessions.entity": SessionEntity,
  "sessions.list": t.Array(SessionEntity),
  // success-response envelopes (see ../../envelope)
  "sessions.res.entity": envelope(SessionEntity),
  "sessions.res.list": envelope(t.Array(SessionEntity)),
  // force-close responds with just the closed session's id
  "sessions.res.deleted": envelope(t.Object({ id: t.String() })),
});
