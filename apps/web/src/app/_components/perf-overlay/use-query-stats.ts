import type { QueryClient } from "@tanstack/react-query";

export interface LiveQueryStats {
  total: number;
  inFlight: number;
  mutationsPending: number;
}

/** Pure read of current live query/mutation counts — call from the poll, not a subscribe. */
export function readLiveQueryStats(queryClient: QueryClient): LiveQueryStats {
  const queries = queryClient.getQueryCache().getAll();
  const inFlight = queries.filter(
    (q) => q.state.fetchStatus === "fetching",
  ).length;
  const mutationsPending = queryClient
    .getMutationCache()
    .getAll()
    .filter((m) => m.state.status === "pending").length;
  return { total: queries.length, inFlight, mutationsPending };
}
