import type { Query, QueryClient } from "@tanstack/react-query";

import {
  EMPTY_INVALIDATION_TAG_SET,
  type InvalidationTagSet,
} from "./cache-tags";
import type { OperationCacheTag } from "./operation-meta";

const tagMatches = (
  candidate: OperationCacheTag,
  invalidation: OperationCacheTag,
) =>
  invalidation.length <= candidate.length &&
  invalidation.every((part, index) => candidate[index] === part);

export const resolveInvalidationTags = (
  invalidates: InvalidationTagSet | undefined,
): InvalidationTagSet => invalidates ?? EMPTY_INVALIDATION_TAG_SET;

/**
 * The one predicate every tag-driven cache operation shares: a query matches
 * when any tag it declares is prefix-matched by any of the given tags.
 */
export const matchesTags =
  (invalidations: readonly OperationCacheTag[]) =>
  (query: Query): boolean =>
    (query.meta?.cacheTags ?? []).some((tag) =>
      invalidations.some((invalidation) => tagMatches(tag, invalidation)),
    );

export async function invalidateOperationTags(
  queryClient: QueryClient,
  invalidations: InvalidationTagSet,
  options?: { removeInactive?: boolean },
) {
  if (invalidations.length === 0) return;
  const predicate = matchesTags(invalidations);
  // Evict inactive baselines immediately; unrelated active refreshes cannot
  // hold navigation or a newly opened editor hostage.
  if (options?.removeInactive)
    queryClient.removeQueries({ predicate, type: "inactive" });
  await queryClient.invalidateQueries({ predicate });
}

export const cancelQueriesByTags = (
  queryClient: QueryClient,
  tags: readonly OperationCacheTag[],
): Promise<void> =>
  tags.length === 0
    ? Promise.resolve()
    : queryClient.cancelQueries({ predicate: matchesTags(tags) });

/** Subscription establishment/resume cannot know which hints were missed. */
export async function resyncOperationQueries(queryClient: QueryClient) {
  const predicate = (query: Query) => Boolean(query.meta?.cacheTags?.length);
  await queryClient.cancelQueries({ predicate });
  // Inactive queries can still own streamed markup awaiting hydration.
  // Preserve that baseline; mount and detail loaders refetch invalidated data.
  await queryClient.invalidateQueries({ predicate });
}
