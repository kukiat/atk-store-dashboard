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
// funnels through). MQTT `shelf_close` and the force-close route don't mutate
// here directly — they resolve a device_id / session id to a userId (read) and
// call the users shelfClose action, which lands back in closeByUser. That keeps
// removal in one place and the state consistent: a row exists iff its user is
// browsing.
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

  // every row currently open at a physical device (matched on device_id, which
  // is unique per device — unlike sku, which the IoT feed repeats). The MQTT
  // shelf_close handler reads this to find whose session to close.
  findByDevice(deviceId: string) {
    return this.list().filter((s) => s.externalDevice.device_id === deviceId);
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
    const qty = Math.max(0, input.takenTotal);
    for (const s of rows) {
      const line = s.items.find((i) => i.sku === input.sku);
      if (qty <= 0) {
        s.items = s.items.filter((i) => i.sku !== input.sku);
      } else if (line) {
        line.qty = qty;
        line.name = input.name; // keep the display name fresh
      } else {
        s.items.push({
          sku: input.sku,
          name: input.name,
          qty,
          unitWeightKg: input.unitWeightKg,
        });
      }
      this.emit({
        type: input.action === "pick" ? "picked" : "returned",
        session: {
          id: s.id,
          userId: s.userId,
          sku: input.sku,
          name: input.name,
          action: input.action,
          deltaQty: input.deltaQty,
          qty,
          items: s.items,
        },
      });
    }
    return rows;
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
