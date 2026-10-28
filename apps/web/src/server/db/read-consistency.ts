import { HYPERDRIVE_CACHE_POLICY } from "./freshness/hyperdrive-cache-policy";

export type MemberReadMarker =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; lastWriteAt: number };

export type ReadConsistencyDecision = {
  consistency: "strong" | "bounded-stale";
  reason:
    | "cached-policy"
    | "fresh-after-write"
    | "marker-required"
    | "invalid-marker"
    | "invalidation-refetch"
    | "authoritative-operation"
    | "single-database";
};

export function decideReadConsistency(options: {
  boundedStaleAvailable: boolean;
  browser: boolean;
  marker: MemberReadMarker;
  forceStrong?: boolean;
  now?: number;
}): ReadConsistencyDecision {
  if (!options.boundedStaleAvailable)
    return { consistency: "strong", reason: "single-database" };
  if (options.forceStrong)
    return { consistency: "strong", reason: "invalidation-refetch" };
  if (options.marker.kind === "invalid")
    return { consistency: "strong", reason: "invalid-marker" };
  if (options.marker.kind === "absent" && !options.browser)
    return { consistency: "strong", reason: "marker-required" };
  if (
    options.marker.kind === "valid" &&
    (options.now ?? Date.now()) <
      options.marker.lastWriteAt +
        HYPERDRIVE_CACHE_POLICY.freshReadSeconds * 1000
  )
    return { consistency: "strong", reason: "fresh-after-write" };
  return { consistency: "bounded-stale", reason: "cached-policy" };
}
