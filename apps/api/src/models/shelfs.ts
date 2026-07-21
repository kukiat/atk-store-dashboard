// Central domain types for the shelfs module. Plain TypeScript shapes for the
// mock store layout; the Elysia/TypeBox schemas live in
// ../modules/shelfs/shelfs.model.ts.
export type ShelfItem = {
  id: string;
  name: string;
  color: string;
  capacity: number;
  qty: number;
  reorder: number;
  // per-unit product weight in kg (from the loadcell device's product record)
  weight: number;
};

export type Shelf = {
  // the device_id from the external IoT feed (e.g. "10005" / "BF67EC") — a
  // string, not a running number; scene badges and the users FK reference it
  id: string;
  name: string;
  // scanQR sku — the users API resolves it to a shelf 1:1 via findBySku. The
  // IoT feed currently returns the same product sku for every device, so this
  // is not guaranteed unique; findBySku then resolves to the first match.
  sku: string;
  type: "wall" | "gondola" | "checkout";
  x: number;
  z: number;
  rotation: number;
  length: number;
  online: boolean;
  items: ShelfItem[];
};

// SSE events for /shelfs/events (both deduped to real changes, deviceId == Shelf.id):
//   online — a device's online status flipped (MQTT loadcell `status` heartbeat).
//            The scene mirrors it: amber LED + locked doors when offline,
//            scannable when online.
//   stock  — a device's on-shelf quantity changed (MQTT loadcell pick/return
//            `currentQty`). The dashboard updates that item's live stock.
export type ShelfEvent =
  | { type: "online"; deviceId: string; online: boolean }
  | { type: "stock"; deviceId: string; sku: string; qty: number };

// ── external IoT device feed ──────────────────────────────────────────
// One row from GET {IOT_API_URL}/devices (response wrapped in { data: [...] }).
// A loadcell device maps onto a Shelf (see toShelf in ../utils/shelfs). This
// mirrors the live payload faithfully; fields not present on every device (an
// audit of the feed on 2026-07-21) are optional.
export type ExternalMqttConnection = {
  id: string;
  connection_name: string;
  host: string;
  port: number;
  enabled: boolean;
};

export type ExternalDeviceProduct = {
  sku: string;
  item_name: string;
  unit_weight_kg: number;
  max_qty: number;
  // on-shelf quantity — only present on configured devices (placeholder
  // "Default Item" rows omit it); seeds Shelf item stock and is updated live by
  // the loadcell pick/return feed (ShelfsService.setStock).
  current_qty?: number;
};

export type ExternalDevice = {
  id: string; // UUID — unused (we key shelves off device_id)
  device_id: string;
  device_name: string;
  location: string;
  branch: string;
  device_type: string; // only "loadcell" becomes a shelf (type via TYPE_OVERRIDES, default "gondola")
  mqtt_connection_id: string;
  mqtt_connection: ExternalMqttConnection;
  telemetry_topic: string;
  status_topic: string;
  command_topic: string;
  response_topic: string;
  calibration_topic: string;
  lwt_topic: string;
  event_topic: string;
  drift_topic: string;
  payload_format: string;
  product: ExternalDeviceProduct;
  position: { x: number; z: number; rotation: number; length: number };
  enabled: boolean;
  status: string; // "online" | "offline" — drives Shelf.online
  created_at: string;
  updated_at: string;
  // present on a subset of devices only
  output_enabled?: boolean;
  last_seen_at?: string;
  data_topic?: string;
};
