import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidate,
} from "~/lib/background-batch-polling";
import {
  invalidateTRPCQueries,
  inventoryMutationInvalidateKeys,
  locationMutationInvalidateKeys,
  productLookupMutationInvalidateKeys,
} from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

interface SessionInvalidateOptions {
  // Also refresh the product-lookup caches (review/capture panes need this;
  // the plain session invalidation does not).
  includeProductLookup?: boolean;
  // Poll any enqueued background work off `result` and re-invalidate once it
  // drains. When false (the expected-photo path), invalidate synchronously
  // without watching.
  watch?: boolean;
  result?: unknown;
}

/**
 * Single parameterized invalidator for the audit-session surfaces. The three
 * former per-cluster helpers differed by which key sets they refreshed and
 * whether they polled background batches; this exposes one `invalidate(...)`
 * that reproduces each behavior via options — do NOT collapse to one behavior,
 * that changes refetch scope for the review/capture panes.
 */
export function useSessionMutations() {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const sessionInvalidateKeys = useMemo(
    () => [
      ...inventoryMutationInvalidateKeys,
      ...locationMutationInvalidateKeys,
    ],
    [],
  );

  const invalidate = useCallback(
    ({
      includeProductLookup = false,
      watch = true,
      result,
    }: SessionInvalidateOptions = {}) => {
      const keys = includeProductLookup
        ? [...sessionInvalidateKeys, ...productLookupMutationInvalidateKeys]
        : sessionInvalidateKeys;
      invalidateTRPCQueries(queryClient, keys);
      if (watch) {
        void watchBatchesAndInvalidate({
          queryClient,
          result,
          invalidateKeys: keys,
          fetchBatchStatus: makeBatchStatusFetcher(queryClient, api),
        });
      }
    },
    [queryClient, api, sessionInvalidateKeys],
  );

  return { sessionInvalidateKeys, invalidate };
}
