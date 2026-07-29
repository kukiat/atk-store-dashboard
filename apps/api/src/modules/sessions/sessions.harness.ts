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
import type { SessionEvent, ExternalDevice, Shelf } from "../../models";

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
function open(userId: number, sku: string, hasProduct = true) {
  svc.open({ userId, sku, shelf: shelf(sku, "Milk (shelf name)"), device: device(sku, hasProduct) });
  drain();
}
const basket = (userId: number) =>
  svc.list().find((s) => s.userId === userId)?.items.map((i) => [i.sku, i.qty]) ?? [];
const shape = (e: SessionEvent) =>
  e.type === "picked" || e.type === "returned"
    ? { type: e.type, action: e.session.action, sku: e.session.sku, name: e.session.name, delta: e.session.deltaQty, qty: e.session.qty }
    : null;

console.log("commanded path (inspectItem):");
{
  open(1, "BEV-001");
  const e1 = drain(); // no events from open itself
  svc.recordUserPickReturn(1, "pick");
  check("first pick emits picked +1 / qty 1", drain().map(shape), [
    { type: "picked", action: "pick", sku: "BEV-001", name: "Fresh Milk", delta: 1, qty: 1 },
  ]);
  check("open emitted no pick events", e1.length, 0);
  svc.recordUserPickReturn(1, "pick");
  check("second pick accumulates to qty 2", drain().map(shape), [
    { type: "picked", action: "pick", sku: "BEV-001", name: "Fresh Milk", delta: 1, qty: 2 },
  ]);
  check("basket holds 2", basket(1), [["BEV-001", 2]]);
  svc.recordUserPickReturn(1, "return");
  check("return emits returned −1 / qty 1", drain().map(shape), [
    { type: "returned", action: "return", sku: "BEV-001", name: "Fresh Milk", delta: -1, qty: 1 },
  ]);
  svc.recordUserPickReturn(1, "return");
  check("returning the last one empties the line", basket(1), []);
  drain();
  svc.recordUserPickReturn(1, "return");
  check("return with nothing held floors at 0, still emits", drain().map(shape), [
    { type: "returned", action: "return", sku: "BEV-001", name: "Fresh Milk", delta: -1, qty: 0 },
  ]);
  svc.closeByUser(1);
  drain();
}

console.log("unconfigured device (product: null) falls back to the shelf line:");
{
  open(2, "BEV-002", false);
  svc.recordUserPickReturn(2, "pick");
  check("name comes off the shelf item", drain().map(shape), [
    { type: "picked", action: "pick", sku: "BEV-002", name: "Milk (shelf name)", delta: 1, qty: 1 },
  ]);
  svc.closeByUser(2);
  drain();
}

console.log("no open session:");
{
  check("commanded pick with no row is a no-op", svc.recordUserPickReturn(99, "pick").length, 0);
  check("…and emits nothing", drain().length, 0);
}

console.log("hardware path still keyed on device+sku, tally-driven:");
{
  open(3, "BEV-001");
  const mqtt = (action: "pick" | "return", deltaQty: number, takenTotal: number) =>
    svc.recordPickReturn({
      deviceId: "10001", sku: "BEV-001", name: "Fresh Milk", unitWeightKg: 0.42,
      action, deltaQty, takenTotal,
    });
  mqtt("pick", -3, 3); // shelf-side delta is negative for a pick; qty comes off takenTotal
  check("takenTotal wins over accumulation", drain().map(shape), [
    { type: "picked", action: "pick", sku: "BEV-001", name: "Fresh Milk", delta: -3, qty: 3 },
  ]);
  check("commanded and hardware share one basket", basket(3), [["BEV-001", 3]]);
  svc.recordUserPickReturn(3, "pick");
  check("a commanded pick continues from the loadcell's count", drain().map(shape), [
    { type: "picked", action: "pick", sku: "BEV-001", name: "Fresh Milk", delta: 1, qty: 4 },
  ]);
  check("wrong sku matches nothing", mqtt2(), 0);
  function mqtt2() {
    return svc.recordPickReturn({
      deviceId: "10001", sku: "OTHER-SKU", name: "x", unitWeightKg: 0,
      action: "pick", deltaQty: 1, takenTotal: 1,
    }).length;
  }
  svc.closeByUser(3);
  drain();
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
