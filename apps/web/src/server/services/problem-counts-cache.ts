import {
  type ProblemsCount,
  problemsCountSchema,
} from "@cubby/schemas/problems";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import {
  getExecutionCtx,
  getProblemCountsCache,
  type ProblemCountsCacheAdapter,
} from "~/server/cf-env";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { Database } from "~/server/db";
import { findProblemCounts } from "~/server/services/problems.service";

import {
  markProblemCountsDirty,
  PROBLEM_COUNTS_DIRTY_KEY,
} from "./problem-counts-dirty";

export { markProblemCountsDirty };

/**
 * For writers outside the entity mutation pipeline (Problems-page fixes,
 * statement rows, purchase/project attach) that cannot call
 * `runMutationSideEffects`. Never throws: a failed mark must not turn an
 * already-committed write into an apparent failure.
 */
export async function markProblemCountsDirtyBestEffort(
  source: string,
): Promise<void> {
  const cache = getProblemCountsCache();
  if (!cache) return;
  try {
    await markProblemCountsDirty(cache);
  } catch (error) {
    console.error("problems.counts.dirty-mark.failed", { source, error });
  }
}

export interface ProblemCountsPort {
  countProblems: typeof findProblemCounts;
}

const productionProblemCountsPort: ProblemCountsPort = {
  countProblems: findProblemCounts,
};

const PROBLEM_COUNTS_CACHE_KEY = "problem-counts:v1";
/** Held while one read is refreshing, so a burst of reads coalesces. */
const PROBLEM_COUNTS_REFRESHING_KEY = "problem-counts:refreshing";
/** KV's minimum TTL; also comfortably above one detector pass. */
const REFRESH_LOCK_SECONDS = 60;

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

/** Above one detector pass; below the point staleness would be noticeable
 * on the badge. Safety net for writers that never call
 * `markProblemCountsDirtyBestEffort` (or a future one that forgets to). */
const MAX_SNAPSHOT_AGE_MS = 10 * 60_000;

/**
 * Whether the snapshot predates the latest dirty mark. KV is eventually
 * consistent across edges, so a mark may be seen a little late; that delays
 * the refresh, never loses it.
 *
 * Also refreshes once a snapshot is simply too old, regardless of a dirty
 * mark: this replaces the removed `cron.problem-counts` sweep and covers
 * writers outside the mutation pipeline that mark best-effort (direct repo
 * deletes and the problems/statement-row/purchase/project workflows).
 */
async function snapshotIsDirty(
  cache: ProblemCountsCacheAdapter,
  snapshot: ProblemCountsSnapshot,
): Promise<string | null> {
  const dirtyAt = await cache.get(PROBLEM_COUNTS_DIRTY_KEY);
  if (dirtyAt && !Number.isNaN(Date.parse(dirtyAt))) {
    if (Date.parse(dirtyAt) > Date.parse(snapshot.coveredThrough)) {
      return dirtyAt;
    }
  }
  return Date.now() - Date.parse(snapshot.coveredThrough) > MAX_SNAPSHOT_AGE_MS
    ? new Date().toISOString()
    : null;
}

/**
 * Refresh once for the dirty horizon unless another read already holds the
 * lock. Runs off the response path via `waitUntil` when an execution context
 * exists; a read outside one (tests, Node dev) refreshes inline.
 */
async function refreshBehindRead(
  db: Database,
  upcLookupClient: UPCLookupClient,
  cache: ProblemCountsCacheAdapter,
  requestedAt: string,
  port: ProblemCountsPort,
): Promise<void> {
  if (await cache.get(PROBLEM_COUNTS_REFRESHING_KEY)) return;
  await cache.put(PROBLEM_COUNTS_REFRESHING_KEY, requestedAt, {
    expirationTtl: REFRESH_LOCK_SECONDS,
  });
  const refresh = refreshCachedProblemCounts(
    db,
    upcLookupClient,
    cache,
    requestedAt,
    port,
  ).catch((error: UnparsedError) => {
    // The snapshot keeps serving; the next read after the lock expires tries
    // again. The mark is still newer than the snapshot, so nothing is lost.
    console.error("problems.counts.refresh-behind-read.failed", error);
  });
  const ctx = getExecutionCtx();
  if (ctx) ctx.waitUntil(refresh);
  else await refresh;
}

export async function getCachedProblemCounts(
  db: Database,
  upcLookupClient: UPCLookupClient,
  cache?: ProblemCountsCacheAdapter,
  port: ProblemCountsPort = productionProblemCountsPort,
): Promise<ProblemsCount> {
  if (cache) {
    const snapshot = await readProblemCountsSnapshot(cache);
    if (snapshot) {
      const dirtyAt = await snapshotIsDirty(cache, snapshot);
      if (dirtyAt) {
        await refreshBehindRead(db, upcLookupClient, cache, dirtyAt, port);
      }
      return snapshot.counts;
    }
  }

  const requestedAt = new Date().toISOString();
  const counts = await port.countProblems(db, upcLookupClient);
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

/** Refresh one requested horizon, retaining the old KV on error. */
export async function refreshCachedProblemCounts(
  db: Database,
  upcLookupClient: UPCLookupClient,
  cache: ProblemCountsCacheAdapter,
  requestedAt: string,
  port: ProblemCountsPort = productionProblemCountsPort,
): Promise<"succeeded" | "skipped"> {
  const previous = await readProblemCountsSnapshot(cache);
  if (
    previous &&
    Date.parse(previous.coveredThrough) >= Date.parse(requestedAt)
  ) {
    return "skipped";
  }
  const counts = await port.countProblems(db, upcLookupClient);
  await writeProblemCountsSnapshot(cache, counts, requestedAt);
  return "succeeded";
}
