import { t, type TSchema } from "elysia";

// Every business response shares one shape: { data, error, success }. On
// success `data` carries the payload and `error` is null; on failure `data`
// is null and `error` is { message }. HTTP status codes stay meaningful —
// `success` is a convenience mirror of res.ok, not a replacement for it.
//
// Only three pieces live here:
//   envelope(schema) — TypeBox combinator for a route's success `response`
//   ok(data)         — runtime wrapper handlers return
//   envelopeError    — an onError handler the business plugins share
//
// SSE routes (/*/events) are deliberately NOT enveloped: text/event-stream has
// its own framing (event: discriminator, data: payload) and no per-frame error
// concept, so envelopeError bails out on them and handlers yield raw sse().

// Success envelope schema. We only ever declare the success (2xx) response on
// routes; the error shape is uniform and documented in api-spec instead, so
// `error` here is always null and `success` always true — the tightest schema
// that still describes the wire exactly (so Swagger doesn't lie).
export const envelope = <T extends TSchema>(schema: T) =>
  t.Object({
    data: schema,
    error: t.Null(),
    success: t.Literal(true),
  });

// Runtime success wrapper — the counterpart to envelope(). Handlers return
// ok(payload) instead of the bare payload.
export const ok = <T>(data: T) => ({
  data,
  error: null,
  success: true as const,
});

// Shared onError for the four business plugins. Applied per-plugin via
// .onError(envelopeError) so its scope is exactly those modules' routes —
// /health-check and unmatched top-level routes on the root app are never touched.
//
// Error origins and how each surfaces here (all confirmed against Elysia 1.4):
//   thrown status(n, msg) — code === n (number), error.response === msg
//   validation (422)      — code === "VALIDATION", short text at error.all[0]
//   in-plugin NOT_FOUND    — code === "NOT_FOUND", error.status === 404
//   anything else          — treated as 500
export function envelopeError({
  code,
  error,
  set,
  path,
}: {
  code: unknown;
  error: unknown;
  set: { status?: number | string };
  path: string;
}) {
  // let SSE errors fall through to Elysia's default handling — wrapping JSON
  // into an event-stream would corrupt the feed
  if (path.endsWith("/events")) return;

  const e = error as {
    status?: number;
    response?: unknown;
    message?: string;
    all?: Array<{ summary?: string; message?: string }>;
  };

  const httpStatus = typeof code === "number" ? code : (e?.status ?? 500);

  let message: string;
  if (code === "VALIDATION") {
    // the raw ValidationError.message is a multi-line JSON dump; the first
    // entry's summary is the human line ("Expected number")
    message = e?.all?.[0]?.summary ?? e?.all?.[0]?.message ?? "Validation failed";
  } else if (typeof e?.response === "string") {
    message = e.response; // thrown status(n, "msg")
  } else {
    message = e?.message ?? String(code);
  }

  set.status = httpStatus;
  return { data: null, error: { message }, success: false as const };
}
