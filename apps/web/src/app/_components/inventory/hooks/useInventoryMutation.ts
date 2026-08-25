import { useMutation, useQueryClient } from "@tanstack/react-query";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { useTRPC } from "~/integrations/trpc/react";
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidate,
} from "~/lib/background-batch-polling";
import { invalidatesFor, invalidateTRPCQueries } from "~/lib/query-keys";

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
    invalidateTRPCQueries(queryClient, invalidatesFor("inventory"));
    void watchBatchesAndInvalidate({
      queryClient,
      result,
      invalidateKeys: invalidatesFor("inventory"),
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
    invalidateTRPCQueries(queryClient, invalidatesFor("product", "lookup"));
  };
}
