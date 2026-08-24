import {
  type ProblemsCount,
  problemsCountSchema,
} from "@cubby/schemas/problems";
import { z } from "zod";
import type { ProblemCountsCacheAdapter } from "~/server/cf-env";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { Database } from "~/server/db";
import { findProblemCounts } from "~/server/services/problems.service";

const PROBLEM_COUNTS_CACHE_KEY = "problem-counts:v1";

const problemCountsSnapshotSchema = z.object({
  version: z.literal(1),
  counts: problemsCountSchema,
  computedAt: z.iso.datetime(),
  coveredThrough: z.iso.datetime(),
});

type ProblemCountsSnapshot = z.infer<typeof problemCountsSnapshotSchema>;

async function readProblemCountsSnapshot(
  cache: ProblemCountsCacheAdapter,
): Promise<ProblemCountsSnapshot | null> {
  const encoded = await cache.get(PROBLEM_COUNTS_CACHE_KEY);
  if (!encoded) return null;
  try {
    const parsed = problemCountsSnapshotSchema.safeParse(JSON.parse(encoded));
    if (!parsed.success) {
      console.warn("problems.counts.cache.invalid", parsed.error.message);
      return null;
    }
    return parsed.data;
  } catch (error) {
    console.warn("problems.counts.cache.invalid-json", error);
    return null;
  }
}

async function writeProblemCountsSnapshot(
  cache: ProblemCountsCacheAdapter,
  counts: ProblemsCount,
  coveredThrough: string,
): Promise<ProblemCountsSnapshot> {
  const snapshot = problemCountsSnapshotSchema.parse({
    version: 1,
    counts,
    computedAt: new Date().toISOString(),
    coveredThrough,
  });
  await cache.put(PROBLEM_COUNTS_CACHE_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export async function getCachedProblemCounts(
  db: Database,
  upcLookupClient: UPCLookupClient,
  cache?: ProblemCountsCacheAdapter,
): Promise<ProblemsCount> {
  if (cache) {
    const snapshot = await readProblemCountsSnapshot(cache);
    if (snapshot) return snapshot.counts;
  }

  const requestedAt = new Date().toISOString();
  const counts = await findProblemCounts(db, upcLookupClient);
  if (cache) {
    try {
      await writeProblemCountsSnapshot(cache, counts, requestedAt);
    } catch (error) {
      // The live calculation is still a valid response. A transient KV write
      // failure must not turn a cold read into a failed Home navigation.
      console.error("problems.counts.cache.seed-failed", error);
    }
  }
  return counts;
}

/** Refresh one requested mutation/cron horizon, retaining the old KV on error. */
export async function refreshCachedProblemCounts(
  db: Database,
  upcLookupClient: UPCLookupClient,
  cache: ProblemCountsCacheAdapter,
  requestedAt: string,
): Promise<"succeeded" | "skipped"> {
  const previous = await readProblemCountsSnapshot(cache);
  if (
    previous &&
    Date.parse(previous.coveredThrough) >= Date.parse(requestedAt)
  ) {
    return "skipped";
  }
  const counts = await findProblemCounts(db, upcLookupClient);
  await writeProblemCountsSnapshot(cache, counts, requestedAt);
  return "succeeded";
}
