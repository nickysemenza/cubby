import { useQuery } from "@tanstack/react-query";
import { locationTreeQueryOptions } from "~/app/locations/location.functions";
import { useHydrated } from "~/hooks/useHydrated";

/**
 * Shared fetch for the raw location tree (`location.makeTree`).
 *
 * Used by the tree-graph and tree-view visualizations, which each transform the
 * result their own way. For inventory-weighted hierarchies (treemap, sunburst),
 * use `useLocationHierarchy` instead — it adds per-location valuation.
 */
export function useLocationTree() {
  const hydrated = useHydrated();
  const query = useQuery(locationTreeQueryOptions());
  return {
    ...query,
    data: hydrated ? query.data : undefined,
    isLoading: !hydrated || query.isLoading,
  };
}
