import type { Shelf, ExternalDevice } from "./shelfs";

// A live shelf-scan session — the bridge between the MQTT loadcell feed and the
// user roster. One row is opened when a shopper's scanQR passes (see the users
// route) and torn down when their browse session ends (UsersService
// .endShelfSession) or the shelf hardware publishes `shelf_close` over MQTT.
// It carries the full Shelf and the raw ExternalDevice so the loadcell handler
// can match an incoming event (keyed on device_id) back to the shopper standing
// there — the reason the raw device is kept alongside the mapped shelf.
// One line of what the shopper is holding at this shelf. 1 device = 1 product,
// so `items` normally has a single line, but it's an array (same shape as
// Shelf.items) to stay future-proof. `qty` is the net taken (picked − returned),
// mirrored from the loadcell's own tally — see SessionsService.recordPickReturn.
export type ShelfSessionItem = {
  sku: string;
  name: string;
  qty: number;
  unitWeightKg: number;
};

// The running tally for one shelf session — the single number source the head
// card renders from, so the card never does arithmetic of its own.
//
// This is the loadcell's own LoadcellSessionSummary (../mqtt/mqtt.types) with
// the optionality normalized away: the device sends `eventPickedQty` on a pick
// frame and `eventAddedQty` on an add frame, never both, and older firmware may
// send neither. Here BOTH are always present — the acting one carries the
// count, the other is 0. Required rather than optional because a stored summary
// is overwritten in place on every event: leave a field absent and the previous
// event's count survives into the next one, which is a card that lies.
//
// The commanded path (Backdoor / inspectItem) has no loadcell to quote, so it
// synthesizes and advances this itself — see SessionsService.recordUserPickReturn.
export type ShelfSessionSummary = {
  openingQty: number; // on-shelf stock when the session opened
  currentQty: number; // on-shelf stock now
  eventPickedQty: number; // units picked by THIS event (0 on an add)
  eventAddedQty: number; // units returned by THIS event (0 on a pick)
  pickedOutTotal: number; // units picked over the whole session
  addedInTotal: number; // units returned over the whole session
  takenTotal: number; // net held in the basket (picked − returned)
};

export type ShelfSession = {
  id: string; // crypto.randomUUID()
  userId: string; // == User.id, the uuid (NOT external_id — see UsersService)
  sku: string; // the scanned sku (scanQR payload)
  shelf: Shelf;
  externalDevice: ExternalDevice; // externalDevice.device_id == MQTT deviceId
  // live basket for this shelf — grows/shrinks as loadcell pick/return events
  // arrive, emptied when the session ends. Ephemeral (dies with the row).
  items: ShelfSessionItem[];
  // running tally for this shelf session, seeded at open() from the shelf's own
  // stock and rewritten on every pick/return. Mirrors `items` for the session's
  // sku, but is the authority the head card reads.
  summary: ShelfSessionSummary;
};

// SSE feed events for /sessions/events:
//   opened          — whole enriched row (scanQR pass)
//   closed          — id + userId only (browse ended, mirrors the users feed)
//   picked/returned — a loadcell pick/return: carries the shopper (userId, for
//                     the scene gesture), the affected line, the running tally
//                     (summary, which the head card renders) and the updated
//                     basket (items, for a dashboard cart view).
//
// `summary` deliberately replaced the old flat `qty` and `deltaQty` fields:
// both were already spelled inside it (takenTotal, and the event counts) and
// three names for one number is exactly the drift applyPickReturn exists to
// prevent. Consumers read summary.* and do no arithmetic.
export type SessionEvent =
  | { type: "opened"; session: ShelfSession }
  | { type: "closed"; session: { id: string; userId: string } }
  | {
      type: "picked" | "returned";
      session: {
        id: string;
        userId: string;
        sku: string;
        name: string;
        action: "pick" | "return";
        summary: ShelfSessionSummary; // running tally after the event
        items: ShelfSessionItem[]; // the session's full basket after the event
      };
    };
