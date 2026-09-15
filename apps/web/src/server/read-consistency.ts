import { hasFreshReadMarker } from "~/lib/fresh-read-marker";

export type ReadConsistencyDecision = {
  consistency: "strong" | "bounded-stale";
  reason:
    | "cached-policy"
    | "client-policy"
    | "fresh-after-write"
    | "non-browser-origin"
    | "single-database";
};

/** Only requests identifiable as Cubby's browser adapter may opt into caching. */
export function isBrowserUiRequest(headers: Pick<Headers, "get">): boolean {
  if (headers.get("sec-fetch-site") === "same-origin") return true;
  const accept = headers.get("accept") ?? "";
  return (
    headers.get("sec-fetch-mode") === "navigate" || accept.includes("text/html")
  );
}

/**
 * Decide which read adapter a request may use before any query is executed.
 * Strong is the conservative default. Browser UI reads and explicitly
 * route-vetted clients may use the bounded-stale adapter, while a post-mutation
 * freshness marker always wins.
 */
export function decideReadConsistency(options: {
  browserRequest: boolean;
  clientAllowsBoundedStale?: boolean;
  boundedStaleAvailable: boolean;
  headers: Pick<Headers, "get">;
}): ReadConsistencyDecision {
  if (!options.browserRequest && !options.clientAllowsBoundedStale) {
    return { consistency: "strong", reason: "non-browser-origin" };
  }
  if (hasFreshReadMarker(options.headers)) {
    return { consistency: "strong", reason: "fresh-after-write" };
  }
  if (!options.boundedStaleAvailable) {
    return { consistency: "strong", reason: "single-database" };
  }
  return {
    consistency: "bounded-stale",
    reason: options.browserRequest ? "cached-policy" : "client-policy",
  };
}
