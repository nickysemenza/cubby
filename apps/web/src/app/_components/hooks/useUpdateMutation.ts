import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { Entity } from "@cubby/schemas/entity";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { entities } from "~/entities/entities";
import { watchBatchesAndInvalidate } from "~/lib/background-batch-polling";
import { invalidateTRPCQueries } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { useTRPC } from "~/trpc/react";

const emptySideEffects: MutationSideEffects = { backgroundBatches: [] };

/**
 * Hook for creating memoized update mutations that properly invalidate caches.
 * Prevents infinite render loops by memoizing the mutation options.
 */
export function useUpdateMutation<TVariables, TData>({
  mutationFn,
  entity,
  invalidateKeys,
}: {
  mutationFn: (callbacks: {
    onSuccess: (data: { sideEffects?: MutationSideEffects }) => void;
    onError: (err: { message?: string }) => void;
  }) => unknown;
  entity: Entity;
  invalidateKeys: readonly QueryKey[];
}) {
  const queryClient = useQueryClient();
  const api = useTRPC();
  const entityLabel = entities[entity].label;

  const mutationOptions = useMemo(
    () =>
      mutationFn({
        onSuccess: (data) => {
          toast.success(
            savedWithBackgroundWork(
              data.sideEffects ?? emptySideEffects,
              `${entityLabel} updated`,
            ),
          );
          invalidateTRPCQueries(queryClient, invalidateKeys);
          // Re-invalidate once queued background work (totals, valuation, AI)
          // drains, so the UI reflects the recomputed values without a reload.
          void watchBatchesAndInvalidate({
            queryClient,
            result: data,
            invalidateKeys,
            fetchBatchStatus: (batchId) =>
              queryClient
                .fetchQuery({
                  ...api.backgroundJobs.getBatch.queryOptions({ batchId }),
                  staleTime: 0,
                })
                .then((batch) => batch.status),
          });
        },
        onError: (err) => {
          toast.error(
            err.message || `Failed to update ${entityLabel.toLowerCase()}`,
          );
        },
      }),
    [mutationFn, entityLabel, invalidateKeys, queryClient, api],
  );

  return useMutation<TData, Error, TVariables>(
    mutationOptions as Parameters<
      typeof useMutation<TData, Error, TVariables>
    >[0],
  );
}
