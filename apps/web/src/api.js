// Single unwrap point for the atk-store API's response envelope.
//
// Every business route answers with { data, error, success } (see
// apps/api/src/envelope.ts). This is the only place the web app reaches into
// that shape: on success it returns `data` (payload / array / object), on
// failure it throws an Error carrying `error.message`. HTTP status still
// carries the truth — we key success off res.ok, not the `success` flag.
//
// NOT for the static mock files (public/mock/*.json) — those are plain JSON,
// never enveloped, so fetch them directly.
export async function apiFetch(url, { method = 'GET', body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: body != null ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  // the envelope is JSON on both success and error; a proxy or crash can still
  // hand back non-JSON, so tolerate a parse failure rather than masking the
  // real status behind a SyntaxError
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* leave payload null */
  }

  if (!res.ok) {
    throw new Error(payload?.error?.message || `HTTP ${res.status}`);
  }
  // unwrap the envelope; fall back to the raw payload if something upstream
  // answered 2xx without one (defensive — every business route envelopes)
  return payload && typeof payload === 'object' && 'data' in payload
    ? payload.data
    : payload;
}
