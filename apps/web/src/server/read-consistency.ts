import { hasFreshReadMarker } from "~/lib/fresh-read-marker";

export type ReadConsistencyDecision = {
  consistency: "strong" | "bounded-stale";
  reason:
    | "cached-policy"
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
 * Strong is the conservative default; only an ordinary browser request with a
 * distinct bounded-stale adapter and no post-mutation marker may use caching.
 */
export function decideReadConsistency(options: {
  browserRequest: boolean;
  boundedStaleAvailable: boolean;
  headers: Pick<Headers, "get">;
}): ReadConsistencyDecision {
  if (!options.browserRequest) {
    return { consistency: "strong", reason: "non-browser-origin" };
  }
  if (hasFreshReadMarker(options.headers)) {
    return { consistency: "strong", reason: "fresh-after-write" };
  }
  if (!options.boundedStaleAvailable) {
    return { consistency: "strong", reason: "single-database" };
  }
  return { consistency: "bounded-stale", reason: "cached-policy" };
}
