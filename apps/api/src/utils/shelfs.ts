import type { ExternalDevice, Shelf } from "../models";

// The IoT feed carries no display colour, so each shelf's single item gets one
// picked from this palette — deterministically, seeded by device_id, so a shelf
// keeps its colour across the per-request refetches (no flicker on reload).
const PALETTE = [
  "#5b8def",
  "#4caf72",
  "#e2574c",
  "#e8a33d",
  "#b07cdb",
  "#efb23a",
  "#f08a3c",
  "#37c2c9",
  "#e07baf",
  "#6fcf6f",
  "#7ed0c3",
];

// stable hash of the device_id → palette index (djb2-ish, order-independent)
function colorFor(deviceId: string): string {
  let h = 0;
  for (let i = 0; i < deviceId.length; i++)
    h = (h * 31 + deviceId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Per-device position fixups for devices the IoT feed ships half-configured
// (e.g. BF6600 comes through with length 0, which renders as nothing and trips
// the scene's length >= 3 guard). Keyed by device_id; the override replaces the
// device's whole position block. Drop an entry once the device is fixed upstream.
const POSITION_OVERRIDES: Record<string, ExternalDevice["position"]> = {
  "BF6600": { x: -3, z: -13.4, rotation: 0, length: 16 },
};

// The IoT feed carries no shelf type (every row is device_type "loadcell"), so
// type is assigned here per device_id. Anything not listed defaults to
// "gondola" (a two-sided island); the two named devices are the exceptions —
// BF6600 hugs the back wall (single-faced "wall") and 10005 is the checkout
// counter. Drop or add entries as the store layout changes.
const TYPE_OVERRIDES: Record<string, Shelf["type"]> = {
  "BF6600": "wall",
  "10005": "checkout",
};

// map one loadcell device onto a Shelf. Fields the IoT feed doesn't carry
// (capacity/qty/reorder, and colour) are mocked; unit_weight_kg lands on the
// item as `weight`. Shelf type comes from TYPE_OVERRIDES (default "gondola");
// other device types are filtered out before we get here.
function toShelf(d: ExternalDevice): Shelf {
  return {
    id: d.device_id,
    name: d.device_name,
    sku: d.product.sku,
    type: TYPE_OVERRIDES[d.device_id] ?? "gondola",
    x: d.position.x,
    z: d.position.z,
    rotation: d.position.rotation,
    length: d.position.length,
    online: d.status === "online",
    items: [
      {
        id: d.product.sku,
        name: d.product.item_name,
        color: colorFor(d.device_id),
        capacity: 10,
        qty: 7,
        reorder: 3,
        weight: d.product.unit_weight_kg,
      }
    ],
  };
}

// Fetch the shelf layout from the external IoT devices API and map it onto our
// Shelf shape. Called per request by the shelfs service (no cache — the web app
// fetches once on load, so freshness is cheap). A non-2xx or network failure
// rejects; the caller turns that into a 502. Only loadcell devices become
// shelves — that is the only device_type we have a shelf mapping for.
export async function fetchDevices(): Promise<Shelf[]> {
  const url = `${process.env.IOT_API_URL}/devices`;
  const res = await fetch(url, {
    headers: { "x-iot-api-key": process.env.IOT_API_KEY ?? "" },
  });
  if (!res.ok)
    throw new Error(`shelfs devices fetch failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data: ExternalDevice[] };
  return (body.data ?? [])
    .filter((d) => d.device_type === "loadcell")
    .map((d) => {
      const position = POSITION_OVERRIDES[d.device_id];
      return toShelf(position ? { ...d, position } : d);
    });
}
