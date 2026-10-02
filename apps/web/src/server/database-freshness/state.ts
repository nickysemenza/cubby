import type { ProblemsCount } from "@cubby/schemas/problems";

import { HYPERDRIVE_CACHE_POLICY } from "~/lib/hyperdrive-cache-policy";

export interface DatabaseFreshness {
  lastWriteAt: number;
  strongUntil: number;
}

export const databaseFreshness = (lastWriteAt: number): DatabaseFreshness => ({
  lastWriteAt,
  strongUntil: lastWriteAt + HYPERDRIVE_CACHE_POLICY.freshReadSeconds * 1000,
});

/** What callers reach through the `DB_FRESHNESS` stub; the Durable Object implements it. */
export interface DatabaseFreshnessRpc {
  readFreshness(): DatabaseFreshness;
  recordWrite(): Promise<DatabaseFreshness>;
  getProblemCounts(): Promise<ProblemsCount>;
}
