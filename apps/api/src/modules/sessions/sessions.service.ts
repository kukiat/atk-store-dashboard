import { Elysia } from "elysia";
import type {
  ShelfSession,
  ShelfSessionSummary,
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

  // scanQR pass: enrich and stash a new session. Idempotent on TWO keys — any
  // stale row for the same shopper is dropped first (an orphan lingering past a
  // prior browse), and so is any row already open at this device.
  //
  // The device rule is not tidiness, it is what makes `summary` truthful: the
  // loadcell's tally belongs to the SCALE, not to a shopper — one pan cannot
  // tell two pairs of hands apart, and it publishes one set of totals per
  // device. Two rows on one device would each be handed those same totals, and
  // the head card over the second shopper would claim picks they never made.
  // One row per device makes the summary single-owner by construction rather
  // than by luck. The newcomer wins: they are the one physically at the shelf.
  //
  // `summary` is seeded from the shelf's own stock so it is complete from the
  // first frame — the card reads it before any pick has happened, and the
  // commanded path has no loadcell to quote and advances this seed itself.
  open(input: {
    userId: string;
    sku: string;
    shelf: Shelf;
    device: ExternalDevice;
  }): ShelfSession {
    this.closeByUser(input.userId); // replace-if-exists, per shopper
    this.drop(
      this.list().filter(
        (s) => s.externalDevice.device_id === input.device.device_id,
      ),
    ); // …and per device
    const stock =
      input.shelf.items.find((i) => i.id === input.sku)?.qty ?? 0;
    const session: ShelfSession = {
      id: crypto.randomUUID(),
      userId: input.userId,
      sku: input.sku,
      shelf: input.shelf,
      externalDevice: input.device,
      items: [], // filled as loadcell pick/return events arrive
      summary: {
        openingQty: stock,
        currentQty: stock,
        eventPickedQty: 0,
        eventAddedQty: 0,
        pickedOutTotal: 0,
        addedInTotal: 0,
        takenTotal: 0,
      },
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
      summary: ShelfSessionSummary;
    },
  ): ShelfSession[] {
    for (const s of rows) {
      const { sku, name, unitWeightKg, summary } = lineFor(s);
      s.summary = summary; // whole-object overwrite: no field survives an event
      const qty = summary.takenTotal; // the basket line IS the net-held tally
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
          summary,
          items: s.items,
        },
      });
    }
    return rows;
  }

  // A loadcell pick/return landed: update the basket of every session open at
  // this device for this sku (matched on BOTH device_id and sku), and emit a
  // picked/returned event per match for the scene gesture + dashboard cart.
  // The whole tally is taken from the device's own summary rather than
  // accumulated here, so a dropped MQTT frame can't drift any of the counts; a
  // line is removed when the net-held falls to 0. The summary arrives already
  // normalized (see normalizeSummary in ../../mqtt/mqtt.client) — the wire's
  // optional event counts are filled in before they reach the ledger.
  // No open session at the device → returns [].
  recordPickReturn(input: {
    deviceId: string;
    sku: string;
    name: string;
    unitWeightKg: number;
    action: "pick" | "return";
    summary: ShelfSessionSummary; // authoritative tally from the loadcell
  }): ShelfSession[] {
    const rows = this.list().filter(
      (s) => s.externalDevice.device_id === input.deviceId && s.sku === input.sku,
    );
    return this.applyPickReturn(rows, input.action, () => ({
      sku: input.sku,
      name: input.name,
      unitWeightKg: input.unitWeightKg,
      summary: input.summary,
    }));
  }

  // The commanded twin of the above: a users `inspectItem` (Backdoor button /
  // POST /users/:id/status) is one item on or off the session's own sku. It
  // lands on the same feed as the hardware so there is a single source of the
  // pick/return gesture and the head card — without this the mock path would be
  // untestable without a live broker.
  //
  // No loadcell tally to trust here, so the summary is SYNTHESIZED: each command
  // advances the row's own seed by one unit. Product fields fall back to the
  // shelf's stock line because the IoT feed ships `product: null` on
  // unconfigured devices. The `browsing` guard on inspectItem means a row
  // exists; no row → returns [].
  //
  // Returning what you aren't holding clamps the EVENT to 0 units rather than
  // flooring the running total. Flooring `takenTotal` while still counting the
  // return would break `takenTotal === pickedOutTotal − addedInTotal`, and the
  // head card now prints all three side by side — numbers that visibly fail to
  // add up. Zero units moved, so nothing is counted; the event is still emitted
  // (the operator asked for the gesture) and the card simply doesn't flash a
  // badge for it.
  recordUserPickReturn(userId: string, action: "pick" | "return"): ShelfSession[] {
    const rows = this.list().filter((s) => s.userId === userId);
    return this.applyPickReturn(rows, action, (s) => {
      const product = s.externalDevice.product;
      const stock = s.shelf.items.find((i) => i.id === s.sku) ?? s.shelf.items[0];
      const prev = s.summary;
      const picked = action === "pick" ? 1 : 0;
      const added = action === "return" ? Math.min(1, prev.takenTotal) : 0;
      return {
        sku: s.sku,
        name: product?.item_name ?? stock?.name ?? s.sku,
        unitWeightKg: product?.unit_weight_kg ?? stock?.weight ?? 0,
        summary: {
          openingQty: prev.openingQty,
          currentQty: Math.max(0, prev.currentQty - picked + added),
          eventPickedQty: picked,
          eventAddedQty: added,
          pickedOutTotal: prev.pickedOutTotal + picked,
          addedInTotal: prev.addedInTotal + added,
          takenTotal: prev.takenTotal + picked - added,
        },
      };
    });
  }

  // tear down every row for a user (normally 0 or 1). The single removal path —
  // UsersService.endShelfSession calls this on every browse exit (shelfClose /
  // leave / walkAway), so MQTT and force-close reach it via the shelfClose
  // action rather than deleting rows themselves.
  closeByUser(userId: string): ShelfSession[] {
    return this.drop(this.list().filter((s) => s.userId === userId));
  }

  // the one place a row leaves the store — closeByUser and open()'s per-device
  // eviction both come through here so every removal emits `closed` exactly once
  private drop(rows: ShelfSession[]): ShelfSession[] {
    for (const s of rows) {
      this.store.delete(s.id);
      this.emit({ type: "closed", session: { id: s.id, userId: s.userId } });
    }
    return rows;
  }
}

export const sessionsServiceInstance = new SessionsService();

export const sessionsService = new Elysia({ name: "sessions.service" }).decorate(
  "sessionsService",
  sessionsServiceInstance,
);
