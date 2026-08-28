import { useMutation, useQueryClient } from "@tanstack/react-query";

import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidateTags,
} from "~/lib/background-batch-polling";
import type { UnparsedError } from "~/lib/error-utils";

/**
 * Returns a callback that invalidates inventory queries and — given the mutation
 * result — re-invalidates once its background work (whole-tree location
 * valuation) drains. Pass the mutation `data` so the poller can watch the batch;
 * called with no args it just invalidates immediately. Safe to pass directly as a
 * React Query `onSuccess` (it receives `data` as its first argument).
 */
export function useInventoryInvalidation() {
  const queryClient = useQueryClient();

  return <Result>(result?: Result) => {
    void invalidateOperationTags(queryClient, ripple.inventory);
    void watchBatchesAndInvalidateTags({
      queryClient,
      result,
      invalidateTags: ripple.inventory,
      fetchBatchStatus: makeBatchStatusFetcher(queryClient),
    });
  };
}

export function useCreateInventoryMutation({
  onSuccess,
  onError,
}: {
  onSuccess?: () => void;
  onError?: (error: UnparsedError) => void;
} = {}) {
  const invalidateInventory = useInventoryInvalidation();

  return useMutation(
    entityMutationOptionsFactory(
      "inventory",
      "create",
    )({
      onSuccess: (data) => {
        invalidateInventory(data);
        onSuccess?.();
      },
      onError,
    }),
  );
}

export function useProductLookupInvalidation() {
  const queryClient = useQueryClient();

  return () => {
    void invalidateOperationTags(queryClient, ripple.productLookup);
  };
}
