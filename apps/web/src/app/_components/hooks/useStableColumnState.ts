import { useRef } from "react";

/**
 * Hook to provide stable state access in TanStack Table column cell renderers.
 *
 * TanStack Table caches column definitions, which means closures in cell renderers
 * capture stale state values. This hook wraps state in a ref that's updated each
 * render, allowing cell renderers to access the latest values.
 *
 * @example
 * ```tsx
 * const stateRef = useStableColumnState({ ingredientMap, totalsMap, isLoading });
 *
 * const columns = useMemo(() => [
 *   columnHelper.display({
 *     id: "cost",
 *     cell: (info) => {
 *       // Read from ref to get latest state (avoids stale closure)
 *       const { totalsMap, isLoading } = stateRef.current;
 *       if (isLoading) return <Skeleton />;
 *       return formatCurrency(totalsMap[info.row.original.id]?.price);
 *     },
 *   }),
 * ], [columnHelper]);
 * ```
 */
export function useStableColumnState<T>(state: T): { current: T } {
  const ref = useRef(state);
  ref.current = state;
  return ref;
}
