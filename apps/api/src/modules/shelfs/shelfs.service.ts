import { Elysia, status } from "elysia";
import type { ExternalDevice, ShelfEvent } from "../../models";
import { fetchLoadcellDevices, toShelf } from "../../utils";

// Stateful view over the external IoT devices. The raw ExternalDevice list is
// the in-memory source of truth (seeded lazily from the feed on first read);
// every Shelf is a transform of it (toShelf). Online status is owned by the
// MQTT loadcell `status` heartbeat from there on — setOnline flips a device's
// status in place and any Shelf mapped afterwards reflects it. A subscribe/emit
// hub feeds the /shelfs/events SSE so the scene can flip a shelf live.
//
// Layout (product/position/name) is frozen at the first fetch — no periodic
// refetch — so a feed outage after boot can't drop the layout; add a manual
// refresh later if upstream layout needs to change without a restart.
class ShelfsService {
  private cache: ExternalDevice[] | null = null; // null until first load
  private loading: Promise<ExternalDevice[]> | null = null; // single-flight guard
  // MQTT online authority, keyed by device_id. Recorded even before the cache
  // loads (a status heartbeat can beat the first read) and applied on load; the
  // live source of truth for online/offline thereafter.
  private online = new Map<string, boolean>();
  private listeners = new Set<(e: ShelfEvent) => void>();

  // event hub — the SSE route subscribes, setOnline broadcasts
  subscribe(fn: (e: ShelfEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ShelfEvent) {
    for (const fn of this.listeners) fn(e);
  }

  // Lazy, single-flight load of the ExternalDevice cache. Pending online
  // overrides (status heartbeats that arrived first) are applied as it lands.
  // A fetch failure rejects and leaves the cache null, so the caller 502s and
  // the next read retries — the old per-request behaviour, minus the refetch.
  private async ensure(): Promise<ExternalDevice[]> {
    if (this.cache) return this.cache;
    if (!this.loading) {
      this.loading = fetchLoadcellDevices()
        .then((devices) => {
          for (const d of devices) {
            const o = this.online.get(d.device_id);
            if (o !== undefined) d.status = o ? "online" : "offline";
          }
          this.cache = devices;
          return devices;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  async list() {
    return (await this.ensure()).map(toShelf);
  }

  async findById(id: string) {
    const d = (await this.ensure()).find((x) => x.device_id === id);
    if (!d) throw status(404, "Shelf not found");
    return toShelf(d);
  }

  // resolve a scanned sku to its shelf. The IoT feed currently returns the same
  // product sku for every device, so this resolves to the first match; an
  // unknown sku is a 404 like findById.
  async findBySku(sku: string) {
    const d = (await this.ensure()).find((x) => x.product.sku === sku);
    if (!d) throw status(404, `SKU ${sku} not found`);
    return toShelf(d);
  }

  // Resolve a scanned sku to its Shelf AND the raw ExternalDevice behind it. The
  // users scanQR route uses this: the shelf drives door gating, the device
  // (device_id) is stashed on the shelf session. Both are fresh copies — a
  // snapshot — so a later online flip doesn't mutate an open session's device.
  async resolveSku(sku: string) {
    const d = (await this.ensure()).find((x) => x.product.sku === sku);
    if (!d) throw status(404, `SKU ${sku} not found`);
    // deep-copy product too so a later setOnline/setStock on the cache doesn't
    // mutate the frozen snapshot the shelf session holds.
    return { shelf: toShelf(d), device: { ...d, product: { ...d.product } } };
  }

  // MQTT loadcell/main/+/status heartbeat → online authority. Records the value
  // (survives / applies even before the cache loads), then, if the cache is
  // loaded and this is a real change, flips device.status in place and emits an
  // `online` event for the scene. Dedup: a heartbeat that doesn't change the
  // state is a no-op — no emit — so the frequent same-state pings stay quiet.
  setOnline(deviceId: string, online: boolean) {
    this.online.set(deviceId, online);
    const d = this.cache?.find((x) => x.device_id === deviceId);
    if (!d) return; // cache not loaded yet (or device unknown) — applied on load
    const next = online ? "online" : "offline";
    if (d.status === next) return; // dedup — no real change
    d.status = next;
    this.emit({ type: "online", deviceId, online });
  }

  // MQTT loadcell pick/return `currentQty` → on-shelf stock. Matched on
  // device_id + sku (1 product per device), mutates the cached
  // product.current_qty in place, and — on a real change — emits a `stock`
  // event for the dashboard. Unknown device / sku mismatch / cache-not-loaded
  // → no-op (stock reseeds from current_qty on the next GET /shelfs anyway).
  setStock(deviceId: string, sku: string, qty: number) {
    const d = this.cache?.find((x) => x.device_id === deviceId);
    if (!d || d.product.sku !== sku) return;
    if (d.product.current_qty === qty) return; // dedup — no real change
    d.product.current_qty = qty;
    this.emit({ type: "stock", deviceId, sku, qty });
  }
}

export const shelfsServiceInstance = new ShelfsService();

export const shelfsService = new Elysia({ name: "shelfs.service" }).decorate(
  "shelfsService",
  shelfsServiceInstance,
);
