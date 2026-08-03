import { Elysia, status } from "elysia";
import type { ExternalDevice, ShelfEvent } from "../../models";
import { fetchLoadcellDevices, toShelf } from "../../utils";

// Stateless view over the external IoT devices. Every read fetches the device
// list live — there is no cached copy and no fallback, so a feed outage 502s
// straight through to the caller (GET /shelfs gates the whole scene mount, so
// an outage is loud by design rather than silently serving a stale layout).
//
// What the service DOES keep is the MQTT truth, as two small overlays keyed by
// device: `online` (status heartbeat) and `stock` (pick/return currentQty).
// Neither is a cache of the feed — they are values the feed doesn't know yet.
// The loadcell reports a pick the instant it happens, well before the IoT REST
// side has caught up, so on every read the freshly fetched devices are passed
// through applyOverlays and the MQTT values win.
//
// Both setters are sync (the MQTT handler lives outside the Elysia graph and
// can't await a fetch), so they dedup against their own overlay rather than
// against the device list. That means a heartbeat for a device_id absent from
// the feed still emits — harmless, both the dashboard and the scene drop events
// for shelves they don't know — and in exchange no event is ever swallowed for
// arriving before the first read, which is what used to drift stock.
class ShelfsService {
  // MQTT online authority, keyed by device_id.
  private online = new Map<string, boolean>();
  // MQTT on-shelf stock, keyed by `${deviceId}::${sku}` (1 product per device,
  // but the sku is part of the key so a product swap can't inherit a stale qty).
  private stock = new Map<string, number>();
  private listeners = new Set<(e: ShelfEvent) => void>();

  private stockKey(deviceId: string, sku: string) {
    return `${deviceId}::${sku}`;
  }

  // event hub — the SSE route subscribes, setOnline/setStock broadcast
  subscribe(fn: (e: ShelfEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ShelfEvent) {
    for (const fn of this.listeners) fn(e);
  }

  // Lay the MQTT overlays over a freshly fetched device list. Mutating in place
  // is safe: the array belongs to this one read and nothing else holds it.
  // SHELFS_FORCE_ONLINE is the demo escape hatch — the IoT feed reports every
  // device offline until its heartbeat lands, and an offline shelf never unlocks
  // its doors (assertHasDoors 409s), so the flag forces them all online. It is
  // applied last, on purpose: it must override the heartbeat, not the reverse.
  private applyOverlays(devices: ExternalDevice[]): ExternalDevice[] {
    const force = process.env.SHELFS_FORCE_ONLINE === "true";
    for (const d of devices) {
      const isOnline = this.online.get(d.device_id);
      if (isOnline !== undefined) {
        d.status = isOnline ? "online" : "offline";
      }
      if (d.product) {
        const qty = this.stock.get(this.stockKey(d.device_id, d.product.sku));
        if (qty !== undefined) d.product.current_qty = qty;
      }
      if (force) {
        d.status = "online";
      }
    }
    return devices;
  }

  // One live fetch of the external device list, overlays applied. A fetch
  // failure rejects and the route turns it into a 502 — no last-known-good copy
  // is kept, so every successful response is current by construction.
  private async load(): Promise<ExternalDevice[]> {
    return this.applyOverlays(await fetchLoadcellDevices());
  }

  async list() {
    return (await this.load()).map(toShelf);
  }

  async findById(id: string) {
    const d = (await this.load()).find((x) => x.device_id === id);
    if (!d) throw status(404, "Shelf not found");
    return toShelf(d);
  }

  // resolve a scanned sku to its shelf. The IoT feed can hand the same product
  // sku to more than one device, so this resolves to the first match; an
  // unknown sku is a 404 like findById.
  async findBySku(sku: string) {
    const d = (await this.load()).find((x) => x.product?.sku === sku);
    if (!d) throw status(404, `SKU ${sku} not found`);
    return toShelf(d);
  }

  // Resolve a scanned sku to its Shelf AND the raw ExternalDevice behind it. The
  // users scanQR route uses this: the shelf drives door gating, the device
  // (device_id) is stashed on the shelf session. Both already carry the MQTT
  // overlays (applyOverlays runs before the mapping) and belong to this request
  // alone, so the session can hold onto them as-is.
  async resolveSku(sku: string) {
    const d = (await this.load()).find((x) => x.product?.sku === sku);
    if (!d) throw status(404, `SKU ${sku} not found`);
    return { shelf: toShelf(d), device: d };
  }

  // MQTT loadcell/main/+/status heartbeat → online authority. Records the value
  // and, on a real change, emits an `online` event for the scene. Dedup is
  // against the overlay itself: a heartbeat that doesn't change the state is a
  // no-op — no emit — so the frequent same-state pings stay quiet.
  setOnline(deviceId: string, online: boolean) {
    if (this.online.get(deviceId) === online) return; // dedup — no real change
    this.online.set(deviceId, online);
    this.emit({ type: "online", deviceId, online });
  }

  // MQTT loadcell pick/return `currentQty` → on-shelf stock, keyed by
  // device_id + sku, and — on a real change — an SSE `stock` event for the
  // dashboard. The value is recorded from the very first frame after boot,
  // whether or not anyone has opened the dashboard yet.
  setStock(deviceId: string, sku: string, qty: number) {
    const key = this.stockKey(deviceId, sku);
    if (this.stock.get(key) === qty) return; // dedup — no real change
    this.stock.set(key, qty);
    this.emit({ type: "stock", deviceId, sku, qty });
  }
}

export const shelfsServiceInstance = new ShelfsService();

export const shelfsService = new Elysia({ name: "shelfs.service" }).decorate(
  "shelfsService",
  shelfsServiceInstance,
);
