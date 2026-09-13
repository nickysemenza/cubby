import type { QueryClient } from "@tanstack/react-query";

import type { InvalidationTagSet } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";

/**
 * How long after a mutation to re-invalidate its tags, in milliseconds.
 *
 * There is no background-job batch left to poll for "done": a mutation's own
 * derived work (an AI description, a recomputed valuation, a refreshed
 * embedding) lands on the queue a few seconds later on its own. A fixed
 * re-check schedule replaces the poll — one check soon after (catches the
 * common case), one further out (catches a slower queue) — rather than
 * watching a batch that no longer exists.
 */
export const DEFERRED_INVALIDATION_DELAYS_MS: readonly number[] = [
  5_000, 30_000,
];

/**
 * Fire-and-forget re-invalidation of `tags` at each of `delaysMs` after a
 * mutation succeeds, so surfaces reading data that lands slightly later than
 * the mutation's own response (an AI description, a recomputed valuation, an
 * embedding) refresh without polling a batch.
 *
 * Returns a cancel function that clears every still-pending timer — call it
 * on unmount, or when a later mutation makes the earlier schedule moot.
 */
export function scheduleDeferredInvalidation(
  queryClient: QueryClient,
  tags: InvalidationTagSet,
  delaysMs: readonly number[] = DEFERRED_INVALIDATION_DELAYS_MS,
): () => void {
  const timers = delaysMs.map((delay) =>
    setTimeout(() => {
      void invalidateOperationTags(queryClient, tags);
    }, delay),
  );
  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}
