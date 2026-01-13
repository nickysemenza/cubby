import { useMemo } from "react";

/**
 * Creates a stable deletable configuration for useEntityList.
 *
 * This hook prevents infinite render loops by memoizing the deletable config object,
 * which would otherwise be recreated on every render when passed inline to useEntityList.
 *
 * @example
 * ```tsx
 * const deletableConfig = useDeletableConfig({
 *   mutationFn: api.product.delete.mutationOptions,
 *   entityLabel: "Product",
 *   invalidateKeys: [queryKeys.product.list],
 * });
 *
 * const { table, ... } = useEntityList({
 *   entity: "product",
 *   deletable: deletableConfig,
 *   // ...
 * });
 * ```
 */
export function useDeletableConfig<T>({
  mutationFn,
  entityLabel,
  invalidateKeys,
}: {
  mutationFn: (callbacks: {
    onSuccess: () => void;
    onError: (err: { message?: string }) => void;
  }) => T;
  entityLabel: string;
  invalidateKeys: readonly unknown[][];
}) {
  return useMemo(
    () => ({
      mutationOptions: mutationFn,
      entityLabel: entityLabel as typeof entityLabel,
      invalidateKeys: invalidateKeys as typeof invalidateKeys,
    }),
    // Include all dependencies - entityLabel and invalidateKeys should be constants
    // (string literal and readonly array) so they won't cause re-renders
    [mutationFn, entityLabel, invalidateKeys],
  );
}
