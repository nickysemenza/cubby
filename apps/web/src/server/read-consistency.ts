import type { DatabaseFreshness } from "~/server/database-freshness/state";

export type ReadConsistencyDecision = {
  consistency: "strong" | "bounded-stale";
  reason:
    | "cached-policy"
    | "fresh-after-write"
    | "freshness-unavailable"
    | "authoritative-operation"
    | "single-database";
};

export function decideReadConsistency(options: {
  boundedStaleAvailable: boolean;
  freshness: DatabaseFreshness | null;
  now?: number;
}): ReadConsistencyDecision {
  if (!options.boundedStaleAvailable)
    return { consistency: "strong", reason: "single-database" };
  if (!options.freshness)
    return { consistency: "strong", reason: "freshness-unavailable" };
  if ((options.now ?? Date.now()) < options.freshness.strongUntil)
    return { consistency: "strong", reason: "fresh-after-write" };
  return { consistency: "bounded-stale", reason: "cached-policy" };
}
