import mqtt, { type MqttClient } from "mqtt";
import type {
  LoadcellEvent,
  LoadcellStatus,
  ShelfClosedStatus,
} from "./mqtt.types";
import type { ShelfSessionSummary } from "../models";
// raw service instances (this handler lives outside the Elysia graph). The
// sessions ledger resolves a device_id → the shopper(s) browsing it; the users
// service runs the shelfClose action that tears the row down and closes the
// scene door; the shelfs service owns the device online state the status
// heartbeat drives.
import { sessionsServiceInstance } from "../modules/sessions/sessions.service";
import { usersServiceInstance } from "../modules/users/users.service";
import { shelfsServiceInstance } from "../modules/shelfs/shelfs.service";

// Live loadcell feed. On API boot we open one MQTT connection and subscribe to
// three topics:
//   {deviceUuid}/loadcell/main/{sessionSku}/event  → +/loadcell/main/+/event
//       per-pick pick/return events off a shelf
//   {deviceUuid}/loadcell/main/{sessionSku}/status → +/loadcell/main/+/status
//       the shelf_closed end-of-session frame (closes the shopper's session)
//   loadcell/main/{deviceId}/status                → loadcell/main/+/status
//       device online/offline heartbeat (no leading uuid, no session level)
// (`+` matches exactly one level, so the two …/status subscriptions never
// overlap: the heartbeat is three levels, shelf_closed is four.)
const EVENT_TOPIC = "+/loadcell/main/+/event";
const SHELF_CLOSED_TOPIC = "+/loadcell/main/+/status";
const STATUS_TOPIC = "loadcell/main/+/status";

let client: MqttClient | null = null;

// Build connection options from env. MQTT_URL carries the broker host; the
// scheme is derived from MQTT_CONNECT_USE_TLS so the URL can be given without
// one (host:port). Username/password are optional.
function connectOptions() {
  const raw = process.env.MQTT_URL ?? "";
  const useTls = process.env.MQTT_CONNECT_USE_TLS === "true";
  // honour an explicit scheme in MQTT_URL; otherwise pick mqtts/mqtt from TLS
  const url = /^\w+:\/\//.test(raw)
    ? raw
    : `${useTls ? "mqtts" : "mqtt"}://${raw}`;

  return {
    url,
    options: {
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      reconnectPeriod: 3000, // auto-retry every 3s if the broker drops
    },
  };
}

// Parse and dispatch one raw message. Two different payload shapes arrive on a
// …/status suffix, so the suffix alone can't route them — we go by topic depth,
// which the broker guarantees (`+` matches exactly one level):
//   5 segments ({uuid}/loadcell/main/{sku}/status) → shelf_closed session frame
//   4 segments (loadcell/main/{deviceId}/status)   → device heartbeat
// Anything else is an …/event. A bad payload is logged and dropped — one
// malformed frame must not take the listener down.
// Exported for the offline harness, which drives it directly instead of
// standing up a broker.
export function handleMessage(topic: string, payload: Buffer) {
  let msg: unknown;
  try {
    msg = JSON.parse(payload.toString());
  } catch (err) {
    console.error(`[mqtt] bad payload on ${topic}:`, err);
    return;
  }

  if (topic.endsWith("/status")) {
    if (topic.split("/").length === 5) {
      onShelfClosed(msg as ShelfClosedStatus);
    } else {
      onLoadcellStatus(msg as LoadcellStatus);
    }
  } else {
    onLoadcellEvent(msg as LoadcellEvent);
  }
}

// Device heartbeat → shelf online state. ShelfsService dedups (a same-state
// heartbeat is a no-op) and emits an `online` event only on a real transition.
function onLoadcellStatus(s: LoadcellStatus) {
  if (!s.deviceId || typeof s.online !== "boolean") return;
  console.log(`[mqtt] status ${s.deviceId} online=${s.online} (${s.reason})`);
  shelfsServiceInstance.setOnline(s.deviceId, s.online);
}

// Where a loadcell event lands.
//   pick / return — update the basket of the session open at this device+sku and
//                   emit picked/returned on /sessions/events (scene gesture +
//                   dashboard cart). No open session → logged and dropped.
// (Session teardown used to ride this topic as an `event: "shelf_close"`; it now
// arrives on the four-level …/status topic — see onShelfClosed.)
function onLoadcellEvent(e: LoadcellEvent) {
  if (e.action === "pick" || e.action === "add") {
    // on-shelf stock is a property of the shelf, not the shopper — update it
    // from currentQty regardless of whether a session is open (dedup + emit
    // happen inside setStock). Then attribute the pick to a session basket.
    shelfsServiceInstance.setStock(e.deviceId, e.sku, e.currentQty);
    recordPickReturn(e);
    return;
  }
  console.log(`[mqtt] ${e.event} ${e.deviceId} — ignored (no handler)`);
}

// Turn a frame's ragged tally into the ledger's ShelfSessionSummary. This is the
// only place the wire's shape is allowed to matter; downstream — the session
// row, the SSE payload, the head card — sees seven numbers that are always
// present. Three things are reconciled here:
//
//  - `sessionSummary` is the modern nested shape. The flat `session*Total` twins
//    on the frame are the older spelling of the same numbers and stand in when
//    it is missing (the pattern the takenTotal read already used).
//  - `eventPickedQty` / `eventAddedQty` are mutually exclusive on the wire — a
//    pick frame carries only the first, an add frame only the second — and
//    older firmware sends neither. The ACTING one falls back to |deltaQty|,
//    which is the same magnitude seen from the shelf's side.
//  - the idle one is pinned to 0 rather than left absent. Stored summaries are
//    overwritten whole on every event, so an absent field would let the previous
//    event's count survive into this one and the card would flash a stale badge.
export function normalizeSummary(e: LoadcellEvent): ShelfSessionSummary {
  const s = e.sessionSummary;
  const moved = Math.abs(e.deltaQty ?? 0);
  return {
    openingQty: s?.openingQty ?? e.sessionOpeningQty ?? 0,
    currentQty: s?.currentQty ?? e.sessionCurrentQty ?? e.currentQty ?? 0,
    eventPickedQty: e.action === "pick" ? (s?.eventPickedQty ?? moved) : 0,
    eventAddedQty: e.action === "add" ? (s?.eventAddedQty ?? moved) : 0,
    pickedOutTotal: s?.pickedOutTotal ?? e.sessionPickedOutTotal ?? 0,
    addedInTotal: s?.addedInTotal ?? e.sessionAddedInTotal ?? 0,
    takenTotal: s?.takenTotal ?? e.sessionTakenTotal ?? 0,
  };
}

// Route a pick/return into the sessions ledger. Matched on device_id AND sku;
// the loadcell's own tally drives every count so a missed frame can't drift it.
function recordPickReturn(e: LoadcellEvent) {
  const rows = sessionsServiceInstance.recordPickReturn({
    deviceId: e.deviceId,
    sku: e.sku,
    name: e.itemName,
    unitWeightKg: e.unitWeightKg,
    action: e.action as "pick" | "return",
    summary: normalizeSummary(e),
  });
  if (rows.length === 0) {
    console.log(`[mqtt] ${e.action} ${e.deviceId}/${e.sku} — no open session, dropped`);
  } else {
    console.log(
      `[mqtt] ${e.action} ${e.deviceId} "${e.itemName}" → user(s) ` +
      rows.map((r) => r.userId).join(","),
    );
  }
}

// The hardware closed a shelf door: the end of a browse session. This is now
// the only path that ends one from the device side.
//
// The closing weigh-in is the most trustworthy stock reading we get — more so
// than the per-pick frames, which can be dropped in flight — so we reconcile the
// shelf from it first, whether or not a session is open (setStock dedups, so an
// unchanged qty emits nothing).
//
// Then we RESOLVE the session and hand off: findByDeviceAndSku is a read, and
// UsersService.shelfClose does the row removal itself via endShelfSession. That
// ordering matters — deleting the row here first would break the ledger's
// invariant ("a row exists iff its user is browsing") the moment shelfClose
// rejects the transition.
function onShelfClosed(s: ShelfClosedStatus) {
  if (s.status !== "shelf_closed") {
    console.log(`[mqtt] status "${s.status}" ${s.device_id} — ignored (no handler)`);
    return;
  }
  const tag = `shelf_closed ${s.device_id}/${s.sku} (${s.reason}, taken ${s.takenTotal})`;
  shelfsServiceInstance.setStock(s.device_id, s.sku, s.currentQty);

  const sessions = sessionsServiceInstance.findByDeviceAndSku(s.device_id, s.sku);
  if (sessions.length === 0) {
    console.log(`[mqtt] ${tag} — no open session`);
    return;
  }
  for (const row of sessions) {
    try {
      usersServiceInstance.applyAction(row.userId, { action: "shelfClose" });
      console.log(`[mqtt] ${tag} — closed session for user ${row.userId}`);
    } catch (err) {
      // The user isn't browsing, so shelfClose refused — which means the row was
      // already an orphan. Dropping it here restores the invariant rather than
      // breaking it, and is the one place outside endShelfSession allowed to.
      console.error(`[mqtt] ${tag} user ${row.userId} failed, dropping orphan row:`, err);
      sessionsServiceInstance.closeByUser(row.userId);
    }
  }
}

// Open the connection and subscribe. Idempotent — a second call is a no-op so a
// hot-reload (bun --watch) doesn't stack listeners. Missing MQTT_URL skips the
// whole thing with a warning rather than throwing, so the HTTP API still boots.
export function startMqtt(): MqttClient | null {
  if (client) return client;
  if (!process.env.MQTT_URL) {
    console.warn("[mqtt] MQTT_URL not set — skipping loadcell feed");
    return null;
  }

  const { url, options } = connectOptions();
  client = mqtt.connect(url, options);

  client.on("connect", () => {
    console.log(`[mqtt] connected to ${url}`);
    const topics = [EVENT_TOPIC, SHELF_CLOSED_TOPIC, STATUS_TOPIC];
    client!.subscribe(topics, (err) => {
      if (err) console.error(`[mqtt] subscribe failed:`, err);
      else console.log(`[mqtt] subscribed to ${topics.join(", ")}`);
    });
  });

  client.on("message", handleMessage);
  client.on("error", (err) => console.error("[mqtt] error:", err.message));
  client.on("reconnect", () => console.log("[mqtt] reconnecting…"));

  return client;
}