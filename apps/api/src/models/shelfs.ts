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

// ── external IoT device feed ──────────────────────────────────────────
// One row from GET {IOT_API_URL}/devices (response wrapped in { data: [...] }).
// A loadcell device maps 1:1 onto a Shelf (see fetchDevices in ../utils/shelfs);
// the many mqtt/topic fields on the real payload have no home here.
export type ExternalDevice = {
  id: string; // UUID — unused (we key shelves off device_id)
  device_id: string;
  device_name: string;
  device_type: string; // only "loadcell" becomes a shelf (type via TYPE_OVERRIDES, default "gondola")
  status: string; // "online" | "offline" — drives Shelf.online
  enabled: boolean;
  product: {
    sku: string;
    item_name: string;
    unit_weight_kg: number;
    max_qty: number;
  };
  position: { x: number; z: number; rotation: number; length: number };
};
