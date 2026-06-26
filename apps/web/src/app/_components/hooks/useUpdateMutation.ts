import type { Entity } from "@cubby/schemas/entity";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { entities } from "~/entities/entities";
import { invalidateTRPCQueries } from "~/lib/query-keys";

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
    onSuccess: () => void;
    onError: (err: { message?: string }) => void;
  }) => unknown;
  entity: Entity;
  invalidateKeys: readonly QueryKey[];
}) {
  const queryClient = useQueryClient();
  const entityLabel = entities[entity].label;

  const mutationOptions = useMemo(
    () =>
      mutationFn({
        onSuccess: () => {
          toast.success(`${entityLabel} updated`);
          invalidateTRPCQueries(queryClient, invalidateKeys);
        },
        onError: (err) => {
          toast.error(
            err.message || `Failed to update ${entityLabel.toLowerCase()}`,
          );
        },
      }),
    [mutationFn, entityLabel, invalidateKeys, queryClient],
  );

  return useMutation<TData, Error, TVariables>(
    mutationOptions as Parameters<
      typeof useMutation<TData, Error, TVariables>
    >[0],
  );
}
