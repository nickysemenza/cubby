// Defensive Sentry PII scrubbing shared by the client (router.tsx) and Workers
// server (cf-server.ts) inits.
//
// Sentry defaults to no PII, but callers can still attach request data manually.
// The MCP endpoint used to accept an API key as a `?key=` query param; it is now
// OAuth-bearer-only (routes/api/mcp.ts), and this scrubber keeps stale URLs
// harmless if one reaches Sentry from any surface.
//
// Kept param-agnostic to `event.request.url` and `event.request.query_string`,
// the two places the SDK serializes the request URL. The calendar feed puts its
// credential in the *path*, so paths are scrubbed too.

import { httpRouteTemplate } from "./http-route-template";

const REDACTED = "[REDACTED]";

// Query params whose values are (or could be) credentials. Matched
// case-insensitively.
const SENSITIVE_QUERY_PARAMS = new Set(["key", "apikey", "api_key", "token"]);

function redactPath(path: string): string {
  try {
    const parsed = new URL(path, "https://sentry-scrub.invalid");
    const template = httpRouteTemplate(parsed.pathname);
    return path.startsWith("/") ? template : `${parsed.origin}${template}`;
  } catch {
    return "/:unmatched";
  }
}

function redactUrl(url: string): string {
  // Split off the query string manually — the URL may be relative (no origin),
  // which `new URL(url)` would reject. Fragment is preserved after redaction.
  const hashIdx = url.indexOf("#");
  const fragment = hashIdx >= 0 ? url.slice(hashIdx) : "";
  const withoutFragment = hashIdx >= 0 ? url.slice(0, hashIdx) : url;

  const queryIdx = withoutFragment.indexOf("?");
  if (queryIdx < 0) return `${redactPath(withoutFragment)}${fragment}`;

  const path = redactPath(withoutFragment.slice(0, queryIdx));
  const query = withoutFragment.slice(queryIdx + 1);

  const scrubbed = redactQueryString(query);
  return scrubbed ? `${path}?${scrubbed}${fragment}` : `${path}${fragment}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactQueryString(query: string): string {
  return query
    .split("&")
    .map((pair) => {
      const eqIdx = pair.indexOf("=");
      const rawName = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
      // A malformed %-sequence in a param name must not throw out of
      // beforeSend — that would drop the whole event. Sensitive names are
      // plain ASCII, so the undecoded fallback still matches them.
      const name = safeDecode(rawName).toLowerCase();
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
