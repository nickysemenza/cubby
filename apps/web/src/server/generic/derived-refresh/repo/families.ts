import { derivedRefreshFamily } from "@cubby/schemas/run-fields";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job } from "~/server/db/retained-tables";
import {
  enqueueJob,
  recordJobInvalidation,
  repeatJob,
} from "~/server/generic/jobs/repo/jobs";

/** The manifest's `derived_refresh` steps are the families. */
export const refreshFamily = derivedRefreshFamily;
export const refreshFamilyInput = z.object({ family: refreshFamily });
export type RefreshFamily = z.infer<typeof refreshFamily>;
export const REFRESH_INTERVAL_MS = 2 * 60_000;
export const REFRESH_PAGE_SIZE = 25;
/**
 * Records one search page scans. A page rebuilds only stale or missing
 * documents, so a scan is cheap; at 25 a full pass over the household corpus
 * (~36k documents) took over a day at drain pace and held connection
 * coverage pending. Matches the quality family's page.
 */
export const SEARCH_REFRESH_PAGE_SIZE = 200;

export async function lockRefreshFamily(
  db: RepositoryQueryInput,
  family: RefreshFamily,
) {
  const saved = await enqueueJob(db, {
    key: `refresh:${family}`,
    kind: "refresh.family",
    input: { family },
  });
  await repositoryQueries(db)
    .select({ id: job.id })
    .from(job)
    .where(eq(job.id, saved.id))
    .for("update");
}

/**
 * Explicit projection dependencies reuse the same durable family Job. The
 * capture writes only the family's invalidation row, never its execution
 * row: a source save's transaction must not conflict with the family Job's
 * claims, renewals and publication on other connections.
 */
export async function invalidateRefreshFamily(
  db: RepositoryQueryInput,
  family: RefreshFamily,
) {
  await recordJobInvalidation(db, {
    key: `refresh:${family}`,
    kind: "refresh.family",
    input: { family },
    // A broad pass outlasts the gap between household writes. Restarting it
    // on each write superseded every page, so production never published:
    // quality first, then search (generation ~29k with new records left
    // unindexed). A pass in progress finishes, then a capture made while it
    // ran leaves it due for a full pass, so an edit behind its cursor or a
    // record created after its cutoff is not lost.
    restartsPass: false,
  });
}

/** Every edit captures a broad pass in its own transaction. No dependency graph is scheduled. */
export async function scheduleRefreshFamilies(
  db: RepositoryQueryInput,
  options: { invalidate: boolean },
) {
  for (const family of refreshFamily.options) {
    const input = {
      key: `refresh:${family}`,
      kind: "refresh.family",
      input: { family },
    };
    if (options.invalidate) await invalidateRefreshFamily(db, family);
    else await repeatJob(db, input, REFRESH_INTERVAL_MS);
  }
}
