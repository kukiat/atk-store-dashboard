// Offline harness for the two pick/return entry points on SessionsService.
//
// Worth having because they are not two features: `inspectItem` (Backdoor
// button / POST /users/:id/status) and the MQTT loadcell both run through
// applyPickReturn, so a slip in sign, sku matching or line removal breaks the
// hardware path as much as the mock one. This exercises the basket arithmetic
// and the emitted event shape with no broker, no HTTP and no browser.
//
// MUST live inside apps/api: run from the repo root and Bun resolves a second
// module graph, so the service instance under test would not be the one the app
// uses. Run it with:  bun apps/api/src/modules/sessions/sessions.harness.ts
import { sessionsServiceInstance as svc } from "./sessions.service";
import { normalizeSummary } from "../../mqtt/mqtt.client";
import type { SessionEvent, ExternalDevice, Shelf } from "../../models";
import type { LoadcellEvent } from "../../mqtt/mqtt.types";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
}

// minimal stand-ins: only the fields the pick/return path reads
const shelf = (sku: string, name: string): Shelf => ({
  id: "10001", name: "Beverages", sku, type: "gondola",
  x: 0, z: 0, rotation: 0, length: 8, online: true,
  items: [{ id: sku, name, color: "#fff", capacity: 10, qty: 5, reorder: 1, weight: 0.4 }],
});
const device = (sku: string, product: boolean): ExternalDevice => ({
  id: "uuid", device_id: "10001", device_name: "Beverages", location: "", branch: "",
  device_type: "loadcell", mqtt_connection_id: "", mqtt_connection: {} as never,
  telemetry_topic: "", status_topic: "", command_topic: "", response_topic: "",
  calibration_topic: "", lwt_topic: "", event_topic: "", drift_topic: "",
  payload_format: "json",
  product: product
    ? { sku, item_name: "Fresh Milk", unit_weight_kg: 0.42, max_qty: 10 }
    : null, // the live feed ships null on unconfigured devices — the fallback path
  position: { x: 0, z: 0, rotation: 0, length: 8 },
  enabled: true, status: "online", created_at: "", updated_at: "",
});

// capture the feed for one call
const events: SessionEvent[] = [];
svc.subscribe((e) => events.push(e));
function drain() {
  const out = events.splice(0);
  return out.filter((e) => e.type === "picked" || e.type === "returned");
}
// The ledger keys on User.id, which is a uuid. Full uuids would drown these
// cases in noise, so the harness works in small numbers and converts at the
// boundary — every svc.* call below goes through one of these.
const uid = (n: number) => `user-${n}`;
function open(userId: number, sku: string, hasProduct = true) {
  svc.open({ userId: uid(userId), sku, shelf: shelf(sku, "Milk (shelf name)"), device: device(sku, hasProduct) });
  drain();
}
const rowOf = (userId: number) => svc.list().find((s) => s.userId === uid(userId));
const pick = (userId: number, action: "pick" | "return") =>
  svc.recordUserPickReturn(uid(userId), action);
const close = (userId: number) => svc.closeByUser(uid(userId));
const basket = (userId: number) =>
  rowOf(userId)?.items.map((i) => [i.sku, i.qty]) ?? [];
// the three numbers the head card actually prints, in card order:
// big number (HELD), then the OUT · IN breakdown, then this event's own count
const tally = (s: {
  takenTotal: number; pickedOutTotal: number; addedInTotal: number;
  eventPickedQty: number; eventAddedQty: number;
}) => [s.takenTotal, s.pickedOutTotal, s.addedInTotal, s.eventPickedQty, s.eventAddedQty];
const shape = (e: SessionEvent) =>
  e.type === "picked" || e.type === "returned"
    ? { type: e.type, action: e.session.action, sku: e.session.sku, name: e.session.name, tally: tally(e.session.summary) }
    : null;

console.log("commanded path (inspectItem) synthesizes a summary:");
{
  open(1, "BEV-001");
  const e1 = drain(); // no events from open itself
  check("open seeds the summary off the shelf stock", tally(rowOf(1)!.summary), [0, 0, 0, 0, 0]);
  check("…with openingQty = currentQty = shelf qty", [
    rowOf(1)!.summary.openingQty,
    rowOf(1)!.summary.currentQty,
  ], [5, 5]);
  pick(1, "pick");
  check("first pick: held 1, out 1, event picked 1", drain().map(shape), [
    { type: "picked", action: "pick", sku: "BEV-001", name: "Fresh Milk", tally: [1, 1, 0, 1, 0] },
  ]);
  check("open emitted no pick events", e1.length, 0);
  pick(1, "pick");
  check("second pick accumulates to held 2 / out 2", drain().map(shape), [
    { type: "picked", action: "pick", sku: "BEV-001", name: "Fresh Milk", tally: [2, 2, 0, 1, 0] },
  ]);
  check("basket holds 2", basket(1), [["BEV-001", 2]]);
  pick(1, "return");
  check("return: held 1, out 2, in 1 — and the pick count is cleared", drain().map(shape), [
    { type: "returned", action: "return", sku: "BEV-001", name: "Fresh Milk", tally: [1, 2, 1, 0, 1] },
  ]);
  pick(1, "return");
  check("returning the last one empties the line", basket(1), []);
  check("…and the card can still tell the whole story at held 0", tally(rowOf(1)!.summary), [0, 2, 2, 0, 1]);
  drain();
  pick(1, "return");
  check("returning what you don't hold moves 0 units, still emits", drain().map(shape), [
    { type: "returned", action: "return", sku: "BEV-001", name: "Fresh Milk", tally: [0, 2, 2, 0, 0] },
  ]);
  close(1);
  drain();
}

console.log("unconfigured device (product: null) falls back to the shelf line:");
{
  open(2, "BEV-002", false);
  pick(2, "pick");
  check("name comes off the shelf item", drain().map(shape), [
    { type: "picked", action: "pick", sku: "BEV-002", name: "Milk (shelf name)", tally: [1, 1, 0, 1, 0] },
  ]);
  close(2);
  drain();
}

console.log("no open session:");
{
  check("commanded pick with no row is a no-op", pick(99, "pick").length, 0);
  check("…and emits nothing", drain().length, 0);
}

console.log("hardware path still keyed on device+sku, tally-driven:");
{
  open(3, "BEV-001");
  const mqtt = (action: "pick" | "return", summary: Partial<LoadcellEvent["sessionSummary"]> & { deltaQty?: number }) =>
    svc.recordPickReturn({
      deviceId: "10001", sku: "BEV-001", name: "Fresh Milk", unitWeightKg: 0.42,
      action,
      summary: normalizeSummary({
        action: action === "pick" ? "pick" : "add",
        deltaQty: summary.deltaQty ?? 0,
        currentQty: 0,
        sessionSummary: summary as LoadcellEvent["sessionSummary"],
      } as LoadcellEvent),
    });
  // shelf-side delta is negative for a pick; every count comes off the summary
  mqtt("pick", { deltaQty: -3, takenTotal: 3, pickedOutTotal: 3, addedInTotal: 0, eventPickedQty: 3, openingQty: 5, currentQty: 2 });
  check("the device's own tally wins over accumulation", drain().map(shape), [
    { type: "picked", action: "pick", sku: "BEV-001", name: "Fresh Milk", tally: [3, 3, 0, 3, 0] },
  ]);
  check("commanded and hardware share one basket", basket(3), [["BEV-001", 3]]);
  pick(3, "pick");
  check("a commanded pick continues from the loadcell's count", drain().map(shape), [
    { type: "picked", action: "pick", sku: "BEV-001", name: "Fresh Milk", tally: [4, 4, 0, 1, 0] },
  ]);
  check("wrong sku matches nothing", mqtt2(), 0);
  function mqtt2() {
    return svc.recordPickReturn({
      deviceId: "10001", sku: "OTHER-SKU", name: "x", unitWeightKg: 0,
      action: "pick",
      summary: { openingQty: 0, currentQty: 0, eventPickedQty: 1, eventAddedQty: 0, pickedOutTotal: 1, addedInTotal: 0, takenTotal: 1 },
    }).length;
  }
  close(3);
  drain();
}

// The wire is ragged where the ledger must not be: the two event counts are
// mutually exclusive per frame and older firmware omits both. Everything past
// this boundary reads seven always-present numbers.
console.log("normalizeSummary fills what the wire leaves out:");
{
  const frame = (over: Partial<LoadcellEvent>) =>
    normalizeSummary({ action: "pick", deltaQty: -2, currentQty: 7, ...over } as LoadcellEvent);
  check("missing event count falls back to |deltaQty|",
    frame({ sessionSummary: { openingQty: 9, currentQty: 7, pickedOutTotal: 2, addedInTotal: 0, takenTotal: 2 } }).eventPickedQty, 2);
  check("the idle count is pinned to 0, never left absent",
    frame({ sessionSummary: { openingQty: 9, currentQty: 7, pickedOutTotal: 2, addedInTotal: 0, takenTotal: 2, eventPickedQty: 2 } }).eventAddedQty, 0);
  check("an add frame fills eventAddedQty, not eventPickedQty",
    tally(frame({ action: "add", deltaQty: 1, sessionSummary: { openingQty: 9, currentQty: 8, pickedOutTotal: 2, addedInTotal: 1, takenTotal: 1 } })),
    [1, 2, 1, 0, 1]);
  check("no sessionSummary at all: the flat session* twins stand in",
    tally(frame({ sessionTakenTotal: 4, sessionPickedOutTotal: 5, sessionAddedInTotal: 1, sessionOpeningQty: 9, sessionCurrentQty: 5 })),
    [4, 5, 1, 2, 0]);
}

// The loadcell's tally belongs to the scale, not to a shopper. Two rows on one
// device would each be handed those same numbers, so the second shopper's card
// would claim picks they never made — the newcomer evicts the incumbent.
console.log("1 device = 1 session:");
{
  open(4, "BEV-001");
  open(5, "BEV-001"); // same device_id "10001"
  check("the incumbent row is gone", svc.list().filter((s) => s.userId === uid(4)).length, 0);
  check("only the newcomer holds the device", svc.list().map((s) => s.userId), [uid(5)]);
  close(5);
  drain();
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
