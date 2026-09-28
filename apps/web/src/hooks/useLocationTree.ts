import { useQuery } from "@tanstack/react-query";

import { useHydrated } from "~/hooks/useHydrated";
import { location } from "~/integrations/tanstack-query/generated/catalog.gen";

/**
 * Shared fetch for the raw location tree (`location.makeTree`).
 *
 * Used by the tree-graph and tree-view visualizations, which each transform the
 * result their own way. For inventory-weighted hierarchies (treemap, sunburst),
 * use `useLocationHierarchy` instead — it adds per-location valuation.
 */
export function useLocationTree() {
  const hydrated = useHydrated();
  const query = useQuery(location.makeTree.queryOptions());
  return {
    ...query,
    data: hydrated ? query.data : undefined,
    isLoading: !hydrated || query.isLoading,
  };
}
