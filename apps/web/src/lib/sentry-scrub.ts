// Defensive Sentry PII scrubbing shared by the client (router.tsx) and Workers
// server (cf-server.ts) inits.
//
// Both inits set `sendDefaultPii: true`, which makes the SDK attach the full
// request URL — including any query string — to captured events. The MCP
// endpoint previously accepted the API key as a `?key=` query param (removed in
// routes/api/mcp.ts); this scrubber is defense-in-depth so that even if a `key`
// query param reaches Sentry from any surface (a stale client URL, a Referer,
// a manually-constructed request), the credential is redacted before the event
// leaves the process.
//
// Kept param-agnostic to `event.request.url` and `event.request.query_string`,
// the two places the SDK serializes the request URL.

const REDACTED = "[REDACTED]";

// Query params whose values are (or could be) credentials. Matched
// case-insensitively.
const SENSITIVE_QUERY_PARAMS = new Set(["key", "apikey", "api_key", "token"]);

function redactUrl(url: string): string {
  // Split off the query string manually — the URL may be relative (no origin),
  // which `new URL(url)` would reject. Fragment is preserved after redaction.
  const hashIdx = url.indexOf("#");
  const fragment = hashIdx >= 0 ? url.slice(hashIdx) : "";
  const withoutFragment = hashIdx >= 0 ? url.slice(0, hashIdx) : url;

  const queryIdx = withoutFragment.indexOf("?");
  if (queryIdx < 0) return url;

  const path = withoutFragment.slice(0, queryIdx);
  const query = withoutFragment.slice(queryIdx + 1);

  const scrubbed = redactQueryString(query);
  return scrubbed ? `${path}?${scrubbed}${fragment}` : `${path}${fragment}`;
}

function redactQueryString(query: string): string {
  return query
    .split("&")
    .map((pair) => {
      const eqIdx = pair.indexOf("=");
      const rawName = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
      const name = decodeURIComponent(rawName).toLowerCase();
      if (SENSITIVE_QUERY_PARAMS.has(name)) {
        return `${rawName}=${REDACTED}`;
      }
      return pair;
    })
    .join("&");
}

/**
 * Sentry `beforeSend` hook: redact sensitive query-param values from the
 * request URL / query_string attached to an event. Returns the mutated event
 * (Sentry passes the event by reference; we return it as the SDK contract
 * expects). Typed loosely (`event: T`) so it works for both the browser and
 * Cloudflare SDK event shapes without importing SDK-specific types here.
 */
export function scrubSentryEvent<
  T extends {
    request?: { url?: string; query_string?: unknown };
  },
>(event: T): T {
  const request = event.request;
  if (!request) return event;

  if (typeof request.url === "string") {
    request.url = redactUrl(request.url);
  }

  if (typeof request.query_string === "string") {
    request.query_string = redactQueryString(request.query_string);
  }

  return event;
}
