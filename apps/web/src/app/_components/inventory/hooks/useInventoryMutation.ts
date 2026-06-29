import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidate,
} from "~/lib/background-batch-polling";
import {
  invalidateTRPCQueries,
  inventoryMutationInvalidateKeys,
  productLookupMutationInvalidateKeys,
} from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

/**
 * Returns a callback that invalidates inventory queries and — given the mutation
 * result — re-invalidates once its background work (whole-tree location
 * valuation) drains. Pass the mutation `data` so the poller can watch the batch;
 * called with no args it just invalidates immediately. Safe to pass directly as a
 * React Query `onSuccess` (it receives `data` as its first argument).
 */
export function useInventoryInvalidation() {
  const queryClient = useQueryClient();
  const api = useTRPC();

  return (result?: unknown) => {
    invalidateTRPCQueries(queryClient, inventoryMutationInvalidateKeys);
    void watchBatchesAndInvalidate({
      queryClient,
      result,
      invalidateKeys: inventoryMutationInvalidateKeys,
      fetchBatchStatus: makeBatchStatusFetcher(queryClient, api),
    });
  };
}

export function useCreateInventoryMutation({
  onSuccess,
  onError,
}: {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
} = {}) {
  const api = useTRPC();
  const invalidateInventory = useInventoryInvalidation();

  return useMutation(
    api.inventory.create.mutationOptions({
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
    invalidateTRPCQueries(queryClient, productLookupMutationInvalidateKeys);
  };
}
