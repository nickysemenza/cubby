import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

import type { OperationCacheTag } from "./operation-meta";

const tagMatches = (
  candidate: OperationCacheTag,
  invalidation: OperationCacheTag,
) =>
  invalidation.length <= candidate.length &&
  invalidation.every((part, index) => candidate[index] === part);

export const resolveInvalidationTags = (
  invalidates: readonly OperationCacheTag[] | undefined,
): readonly OperationCacheTag[] => invalidates ?? [];

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

export function invalidateOperationTags(
  queryClient: QueryClient,
  invalidations: readonly OperationCacheTag[],
) {
  if (invalidations.length === 0) return Promise.resolve();
  return queryClient.invalidateQueries({
    predicate: matchesTags(invalidations),
  });
}

export const cancelQueriesByTags = (
  queryClient: QueryClient,
  tags: readonly OperationCacheTag[],
): Promise<void> =>
  tags.length === 0
    ? Promise.resolve()
    : queryClient.cancelQueries({ predicate: matchesTags(tags) });

export const snapshotQueriesByTags = (
  queryClient: QueryClient,
  tags: readonly OperationCacheTag[],
): Array<[QueryKey, unknown]> =>
  tags.length === 0
    ? []
    : queryClient.getQueriesData({ predicate: matchesTags(tags) });

export const updateQueriesByTags = <TData>(
  queryClient: QueryClient,
  tags: readonly OperationCacheTag[],
  updater: (old: TData | undefined) => TData | undefined,
): void => {
  if (tags.length === 0) return;
  queryClient.setQueriesData<TData>({ predicate: matchesTags(tags) }, updater);
};

/** Roll a snapshot from `snapshotQueriesByTags` back into the cache. */
export const restoreQueries = (
  queryClient: QueryClient,
  snapshot: ReadonlyArray<readonly [QueryKey, unknown]>,
): void => {
  for (const [key, data] of snapshot) queryClient.setQueryData(key, data);
};
