import mqtt, { type MqttClient } from "mqtt";
import type { LoadcellEvent, LoadcellStatus } from "./mqtt.types";
// raw service instances (this handler lives outside the Elysia graph). The
// sessions ledger resolves a device_id → the shopper(s) browsing it; the users
// service runs the shelfClose action that tears the row down and closes the
// scene door; the shelfs service owns the device online state the status
// heartbeat drives.
import { sessionsServiceInstance } from "../modules/sessions/sessions.service";
import { usersServiceInstance } from "../modules/users/users.service";
import { shelfsServiceInstance } from "../modules/shelfs/shelfs.service";

// Live loadcell feed. On API boot we open one MQTT connection and subscribe to
// two topics:
//   {deviceUuid}/loadcell/main/{sessionSku}/event  → +/loadcell/main/+/event
//       per-pick pick/return + shelf_close events off a shelf
//   loadcell/main/{deviceId}/status                → loadcell/main/+/status
//       device online/offline heartbeat (no leading uuid, no session level)
// (`+` matches exactly one level.)
const EVENT_TOPIC = "+/loadcell/main/+/event";
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

// Parse and dispatch one raw message, routed by topic (…/status vs …/event). A
// bad payload is logged and dropped — one malformed frame must not take the
// listener down.
function handleMessage(topic: string, payload: Buffer) {
  let msg: unknown;
  try {
    msg = JSON.parse(payload.toString());
  } catch (err) {
    console.error(`[mqtt] bad payload on ${topic}:`, err);
    return;
  }
  if (topic.endsWith("/status")) onLoadcellStatus(msg as LoadcellStatus);
  else onLoadcellEvent(msg as LoadcellEvent);
}

// Device heartbeat → shelf online state. ShelfsService dedups (a same-state
// heartbeat is a no-op) and emits an `online` event only on a real transition.
function onLoadcellStatus(s: LoadcellStatus) {
  if (!s.deviceId || typeof s.online !== "boolean") return;
  console.log(`[mqtt] status ${s.deviceId} online=${s.online} (${s.reason})`);
  shelfsServiceInstance.setOnline(s.deviceId, s.online);
}

// Where a loadcell event lands.
//   shelf_close   — the hardware closed the shelf: find whoever is browsing this
//                   device and run their shelfClose (row teardown + scene door +
//                   user browsing→inside), same as the /sessions/:id force-close.
//   pick / return — update the basket of the session open at this device+sku and
//                   emit picked/returned on /sessions/events (scene gesture +
//                   dashboard cart). No open session → logged and dropped.
function onLoadcellEvent(e: LoadcellEvent) {
  if (e.event === "shelf_close") {
    closeSessionsAt(e.deviceId);
    return;
  }
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

// Route a pick/return into the sessions ledger. Matched on device_id AND sku;
// the loadcell's own net-taken tally (sessionSummary.takenTotal) drives the held
// qty so a missed frame can't drift it.
function recordPickReturn(e: LoadcellEvent) {
  const rows = sessionsServiceInstance.recordPickReturn({
    deviceId: e.deviceId,
    sku: e.sku,
    name: e.itemName,
    unitWeightKg: e.unitWeightKg,
    action: e.action as "pick" | "return",
    deltaQty: e.deltaQty,
    takenTotal: e.sessionSummary?.takenTotal ?? e.sessionTakenTotal ?? 0,
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

// Close every open session at a device (0 or 1 in practice). We don't delete
// rows here — the shelfClose action funnels through endShelfSession, the single
// removal point. Each call is guarded so one non-browsing shopper (a race where
// the row is already gone) can't sink the rest.
function closeSessionsAt(deviceId: string) {
  const sessions = sessionsServiceInstance.findByDevice(deviceId);
  if (sessions.length === 0) {
    console.log(`[mqtt] shelf_close ${deviceId} — no open session`);
    return;
  }
  for (const s of sessions) {
    try {
      usersServiceInstance.applyAction(s.userId, { action: "shelfClose" });
      console.log(`[mqtt] shelf_close ${deviceId} — closed session for user ${s.userId}`);
    } catch (err) {
      console.error(`[mqtt] shelf_close ${deviceId} user ${s.userId} failed:`, err);
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
    const topics = [EVENT_TOPIC, STATUS_TOPIC];
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