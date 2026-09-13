import type { ProblemCountsCacheAdapter } from "~/server/cf-env";

/**
 * The KV keys shared by the dirty mark (written by every mutation) and the
 * badge read (which refreshes once it sees a mark newer than its snapshot).
 * Kept in a leaf module so the mutation side-effect pipeline can mark the
 * snapshot dirty without importing the detectors themselves — that import
 * would close a cycle through the entity repositories.
 */
export const PROBLEM_COUNTS_DIRTY_KEY = "problem-counts:dirty-at";

export async function markProblemCountsDirty(
  cache: ProblemCountsCacheAdapter,
  at: Date = new Date(),
): Promise<void> {
  await cache.put(PROBLEM_COUNTS_DIRTY_KEY, at.toISOString());
}
