// Payload shapes for the loadcell MQTT feed. Each device publishes a JSON
// string on `{uuid}/loadcell/main/{sessionSku}/event`; the client parses it into
// a LoadcellEvent (see ./mqtt.client). The topic itself also carries the uuid
// and sessionSku, but they are duplicated in the body, so the parsed event is
// self-contained.

// Device heartbeat on loadcell/main/{deviceId}/status. We only act on
// deviceId + online (drives Shelf/ExternalDevice online via ShelfsService
// .setOnline); the rest is telemetry we currently ignore.
export type LoadcellStatus = {
  deviceId: string;
  branch: string;
  seq: number;
  online: boolean;
  reason: string; // e.g. "heartbeat"
  uptime: number;
  freeHeap: number;
  rssi: number;
};

// End-of-session summary the device publishes on
// {deviceUuid}/loadcell/main/{sessionSku}/status when the shelf door closes —
// four topic levels, unlike the three-level heartbeat above, which is how the
// two are told apart (see ./mqtt.client). Fields are snake_case here because
// that is how they arrive on the wire; we keep them faithful so a payload
// captured off the broker lines up with the type. Only `device_id`, `sku`,
// `status` and `currentQty` are acted on — the rest is kept for logging and
// documentation of the frame.
export type ShelfClosedStatus = {
  uuid: string; // device UUID (also in the topic)
  sku: string; // product UUID == ShelfSession.sku (also in the topic)
  device_id: string; // == Shelf.id (external device_id)
  status: string; // "shelf_closed" — anything else is ignored
  reason: string; // e.g. "done"
  started_at: string; // ISO-8601, when the door opened
  closed_at: string; // ISO-8601, when it closed
  openingQty: number;
  currentQty: number; // closing weigh-in — authoritative on-shelf stock
  pickedOutTotal: number;
  addedInTotal: number;
  takenTotal: number; // net taken over the whole session
};

// Rolling per-session tally the device ships alongside every event.
export type LoadcellSessionSummary = {
  addedInTotal: number;
  currentQty: number;
  eventPickedQty: number;
  openingQty: number;
  pickedOutTotal: number;
  takenTotal: number;
};

// One `item_picked` / `item_returned` event off a loadcell shelf. `deviceId`
// matches Shelf.id (the external device_id); `sku` / `sessionSku` are the
// product UUID. Weights are kilograms; quantities are unit counts. `action` is
// the coarse verb ("pick" | "return"); `event` is the fine-grained variant.
export type LoadcellEvent = {
  action: 'pick' | "add"; // "pick" | "add"
  branch: string; // "main"
  currentQty: number;
  deltaQty: number; // signed: negative on a pick, positive on a return
  deltaWeightKg: number;
  deviceId: string; // == Shelf.id (external device_id)
  event: string; // "item_picked" | "item_returned"
  grossWeightKg: number;
  itemName: string;
  netWeightKg: number;
  pickedQty: number;
  previousQty: number;
  qtyRemainder: number;
  rssi: number;
  seq: number;
  sessionAddedInTotal: number;
  sessionCurrentQty: number;
  sessionOpeningQty: number;
  sessionPickedOutTotal: number;
  sessionSku: string; // product UUID (also in the topic)
  sessionSummary: LoadcellSessionSummary;
  sessionTakenTotal: number;
  sku: string; // product UUID
  timestamp: string; // ISO-8601
  unitWeightKg: number;
  unitWeightTolerancePercent: number;
  uuid: string; // device UUID (also in the topic)
};

