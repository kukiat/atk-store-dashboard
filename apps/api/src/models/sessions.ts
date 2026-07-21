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

export type ShelfSession = {
  id: string; // crypto.randomUUID()
  userId: number; // == User.id (the shopper who scanned in)
  sku: string; // the scanned sku (scanQR payload)
  shelf: Shelf;
  externalDevice: ExternalDevice; // externalDevice.device_id == MQTT deviceId
  // live basket for this shelf — grows/shrinks as loadcell pick/return events
  // arrive, emptied when the session ends. Ephemeral (dies with the row).
  items: ShelfSessionItem[];
};

// SSE feed events for /sessions/events:
//   opened          — whole enriched row (scanQR pass)
//   closed          — id + userId only (browse ended, mirrors the users feed)
//   picked/returned — a loadcell pick/return: carries the shopper (userId, for
//                     the scene gesture), the affected line, and the updated
//                     basket (items, for a dashboard cart view).
export type SessionEvent =
  | { type: "opened"; session: ShelfSession }
  | { type: "closed"; session: { id: string; userId: number } }
  | {
      type: "picked" | "returned";
      session: {
        id: string;
        userId: number;
        sku: string;
        name: string;
        action: "pick" | "return";
        deltaQty: number; // shelf-side signed delta straight off the loadcell
        qty: number; // net taken for this sku after the event
        items: ShelfSessionItem[]; // the session's full basket after the event
      };
    };
