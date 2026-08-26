import type { QueryClient } from "@tanstack/react-query";
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

export function invalidateOperationTags(
  queryClient: QueryClient,
  invalidations: readonly OperationCacheTag[],
) {
  if (invalidations.length === 0) return Promise.resolve();
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const tags = query.meta?.cacheTags ?? [];
      return tags.some((tag) =>
        invalidations.some((invalidation) => tagMatches(tag, invalidation)),
      );
    },
  });
}
