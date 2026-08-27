import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidateTags,
} from "~/lib/background-batch-polling";

interface SessionInvalidateOptions {
  // Poll any enqueued background work off `result` and re-invalidate once it
  // drains. When false (the expected-photo path), invalidate synchronously
  // without watching.
  watch?: boolean;
  result?: unknown;
}

/**
 * Single parameterized invalidator for the audit-session surfaces.
 *
 * The inventory ripple already covers everything the three former per-cluster
 * helpers named: the location surfaces a bin's contents are read through, and
 * the product-lookup surfaces the review/capture panes wanted — the old
 * `includeProductLookup` flag selected a strict subset of it.
 */
export function useSessionMutations() {
  const queryClient = useQueryClient();

  const invalidate = useCallback(
    ({ watch = true, result }: SessionInvalidateOptions = {}) => {
      void invalidateOperationTags(queryClient, ripple.inventory);
      if (watch) {
        void watchBatchesAndInvalidateTags({
          queryClient,
          result,
          invalidateTags: ripple.inventory,
          fetchBatchStatus: makeBatchStatusFetcher(queryClient),
        });
      }
    },
    [queryClient],
  );

  return { invalidate };
}
