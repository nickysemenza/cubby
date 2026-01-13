import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";

/**
 * Hook for creating memoized update mutations that properly invalidate caches.
 * Prevents infinite render loops by memoizing the mutation options.
 *
 * @example
 * const updateMutation = useUpdateMutation({
 *   mutationFn: api.product.update.mutationOptions,
 *   entity: "product",
 *   invalidateKeys: [queryKeys.product.list],
 * });
 *
 * // Later in your code:
 * await updateMutation.mutateAsync({ id: "123", data: { name: "New Name" } });
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
          for (const key of invalidateKeys) {
            // Wrap key in array to match tRPC's nested structure: [["entity", "list"], {...}]
            void queryClient.invalidateQueries({ queryKey: [key] });
          }
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
