import { Elysia } from "elysia";
import type {
  ShelfSession,
  SessionEvent,
  Shelf,
  ExternalDevice,
} from "../../models";

// In-memory ledger of live shelf-scan sessions — the bridge between the MQTT
// loadcell feed and the user roster (see ShelfSession in ../../models). A row is
// opened when a shopper's scanQR passes and closed when their browse session
// ends; it holds the raw ExternalDevice so a loadcell event (keyed on
// device_id) can be attributed back to the shopper.
//
// Two mutation entry points only: `open` (scanQR pass, from the users route)
// and `closeByUser` (from UsersService.endShelfSession, which every browse-exit
// funnels through). MQTT `shelf_closed` and the force-close route don't mutate
// here directly — they resolve a device_id / session id to a userId (read) and
// call the users shelfClose action, which lands back in closeByUser. That keeps
// removal in one place and the state consistent: a row exists iff its user is
// browsing. (One sanctioned exception: if shelfClose rejects the transition the
// MQTT handler calls closeByUser to drop what is by then a proven orphan row.)
class SessionsService {
  private store = new Map<string, ShelfSession>();
  private listeners = new Set<(e: SessionEvent) => void>();

  // event hub — the SSE route subscribes, mutations broadcast
  subscribe(fn: (e: SessionEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SessionEvent) {
    for (const fn of this.listeners) fn(e);
  }

  list() {
    return [...this.store.values()];
  }

  get(id: string) {
    return this.store.get(id);
  }

  // every row currently open at a physical device for a given sku. The MQTT
  // shelf_closed handler reads this (read-only — it closes via the users
  // shelfClose action) to find whose session the hardware just ended. Matched on
  // BOTH keys like recordPickReturn: device_id alone is already unique, but a
  // sku mismatch means the frame doesn't describe the session we think it does,
  // so we'd rather match nothing than close the wrong row.
  findByDeviceAndSku(deviceId: string, sku: string) {
    return this.list().filter(
      (s) => s.externalDevice.device_id === deviceId && s.sku === sku,
    );
  }

  // scanQR pass: enrich and stash a new session. Idempotent per user — any stale
  // row for the same shopper is dropped first, so one user never holds two rows
  // (guards against an orphan lingering past a prior browse). Returns the row.
  open(input: {
    userId: number;
    sku: string;
    shelf: Shelf;
    device: ExternalDevice;
  }): ShelfSession {
    this.closeByUser(input.userId); // replace-if-exists
    const session: ShelfSession = {
      id: crypto.randomUUID(),
      userId: input.userId,
      sku: input.sku,
      shelf: input.shelf,
      externalDevice: input.device,
      items: [], // filled as loadcell pick/return events arrive
    };
    this.store.set(session.id, session);
    this.emit({ type: "opened", session });
    return session;
  }

  // Shared tail of both pick/return entry points (hardware and commanded):
  // rewrite each matching row's basket line to the resolved net-held qty and
  // emit one picked/returned per row. Deliberately the only place that touches
  // `items` or shapes the event — the two callers must not be able to drift
  // apart on sign, line removal or event shape, since the dashboard cart and
  // the scene gesture read them identically. `lineFor` is per row because the
  // commanded path derives qty from what that row is already holding.
  private applyPickReturn(
    rows: ShelfSession[],
    action: "pick" | "return",
    lineFor: (s: ShelfSession) => {
      sku: string;
      name: string;
      unitWeightKg: number;
      qty: number;
      deltaQty: number;
    },
  ): ShelfSession[] {
    for (const s of rows) {
      const { sku, name, unitWeightKg, qty, deltaQty } = lineFor(s);
      const line = s.items.find((i) => i.sku === sku);
      if (qty <= 0) {
        s.items = s.items.filter((i) => i.sku !== sku);
      } else if (line) {
        line.qty = qty;
        line.name = name; // keep the display name fresh
      } else {
        s.items.push({ sku, name, qty, unitWeightKg });
      }
      this.emit({
        type: action === "pick" ? "picked" : "returned",
        session: {
          id: s.id,
          userId: s.userId,
          sku,
          name,
          action,
          deltaQty,
          qty,
          items: s.items,
        },
      });
    }
    return rows;
  }

  // A loadcell pick/return landed: update the basket of every session open at
  // this device for this sku (matched on BOTH device_id and sku), and emit a
  // picked/returned event per match for the scene gesture + dashboard cart.
  // `qty` is set from the loadcell's own net-taken tally (takenTotal) rather
  // than accumulated here, so a dropped MQTT frame can't drift the count; a line
  // is removed when it falls to 0. No open session at the device → returns [].
  recordPickReturn(input: {
    deviceId: string;
    sku: string;
    name: string;
    unitWeightKg: number;
    action: "pick" | "return";
    deltaQty: number;
    takenTotal: number; // authoritative net-taken from the loadcell
  }): ShelfSession[] {
    const rows = this.list().filter(
      (s) => s.externalDevice.device_id === input.deviceId && s.sku === input.sku,
    );
    return this.applyPickReturn(rows, input.action, () => ({
      sku: input.sku,
      name: input.name,
      unitWeightKg: input.unitWeightKg,
      qty: Math.max(0, input.takenTotal),
      deltaQty: input.deltaQty,
    }));
  }

  // The commanded twin of the above: a users `inspectItem` (Backdoor button /
  // POST /users/:id/status) is one item on or off the session's own sku. It
  // lands on the same feed as the hardware so there is a single source of the
  // pick/return gesture and the head card — without this the mock path would be
  // untestable without a live broker.
  //
  // No loadcell tally to trust here, so qty accumulates from what the row
  // already holds (floored at 0: returning what you aren't holding is a no-op on
  // the count, not a negative). Product fields fall back to the shelf's stock
  // line because the IoT feed ships `product: null` on unconfigured devices.
  // The `browsing` guard on inspectItem means a row exists; no row → returns [].
  recordUserPickReturn(userId: number, action: "pick" | "return"): ShelfSession[] {
    const rows = this.list().filter((s) => s.userId === userId);
    const deltaQty = action === "pick" ? 1 : -1;
    return this.applyPickReturn(rows, action, (s) => {
      const product = s.externalDevice.product;
      const stock = s.shelf.items.find((i) => i.id === s.sku) ?? s.shelf.items[0];
      const held = s.items.find((i) => i.sku === s.sku)?.qty ?? 0;
      return {
        sku: s.sku,
        name: product?.item_name ?? stock?.name ?? s.sku,
        unitWeightKg: product?.unit_weight_kg ?? stock?.weight ?? 0,
        qty: Math.max(0, held + deltaQty),
        deltaQty,
      };
    });
  }

  // tear down every row for a user (normally 0 or 1). The single removal path —
  // UsersService.endShelfSession calls this on every browse exit (shelfClose /
  // leave / walkAway), so MQTT and force-close reach it via the shelfClose
  // action rather than deleting rows themselves.
  closeByUser(userId: number): ShelfSession[] {
    const gone = this.list().filter((s) => s.userId === userId);
    for (const s of gone) {
      this.store.delete(s.id);
      this.emit({ type: "closed", session: { id: s.id, userId: s.userId } });
    }
    return gone;
  }
}

export const sessionsServiceInstance = new SessionsService();

export const sessionsService = new Elysia({ name: "sessions.service" }).decorate(
  "sessionsService",
  sessionsServiceInstance,
);
