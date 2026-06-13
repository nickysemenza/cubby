import { unsafeLocationId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "~/trpc/react";

/**
 * Synthetic id for the virtual root node that tree visualizations prepend above
 * the real top-level locations. Not a real location — never sent to the server.
 */
export const ROOT_LOCATION_ID = unsafeLocationId("_root");

/**
 * Shared fetch for the raw location tree (`location.makeTree`).
 *
 * Used by the tree-graph and tree-view visualizations, which each transform the
 * result their own way. For inventory-weighted hierarchies (treemap, sunburst),
 * use `useLocationHierarchy` instead — it adds per-location valuation.
 */
export function useLocationTree() {
  const api = useTRPC();
  return useQuery(api.location.makeTree.queryOptions());
}
