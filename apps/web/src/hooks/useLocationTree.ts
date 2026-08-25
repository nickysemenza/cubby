import { useQuery } from "@tanstack/react-query";
import { useHydrated } from "~/hooks/useHydrated";
import { useTRPC } from "~/integrations/trpc/react";

/**
 * Shared fetch for the raw location tree (`location.makeTree`).
 *
 * Used by the tree-graph and tree-view visualizations, which each transform the
 * result their own way. For inventory-weighted hierarchies (treemap, sunburst),
 * use `useLocationHierarchy` instead — it adds per-location valuation.
 */
export function useLocationTree() {
  const api = useTRPC();
  const hydrated = useHydrated();
  const query = useQuery(api.location.makeTree.queryOptions());
  return {
    ...query,
    data: hydrated ? query.data : undefined,
    isLoading: !hydrated || query.isLoading,
  };
}
