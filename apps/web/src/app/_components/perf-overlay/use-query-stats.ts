import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { recordQuery } from "~/lib/perf/perf-store";

export interface LiveQueryStats {
  total: number;
  inFlight: number;
  mutationsPending: number;
}

/** Nested query keys such as `[["recipe","detail"], input]` become "recipe.detail". */
function procedureName(queryKey: unknown): string {
  const first = Array.isArray(queryKey) ? queryKey[0] : queryKey;
  if (Array.isArray(first)) return first.join(".");
  return String(first);
}

/**
 * Records per-procedure fetch durations into the perf store (also feeding the
 * fan-out detector). The subscribe callback runs inside React Query's synchronous
 * notify cascade, so it MUST NOT call setState — it only writes to the (non-React)
 * perf store. Live counts are read separately via `readLiveQueryStats` on a poll.
 */
export function useQueryTimingRecorder(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const queryCache = queryClient.getQueryCache();
    const starts = new Map<string, number>(); // queryHash → fetch start time
    return queryCache.subscribe((event) => {
      const query = event.query;
      const hash = query.queryHash;
      if (query.state.fetchStatus === "fetching") {
        if (!starts.has(hash)) starts.set(hash, performance.now());
      } else {
        const start = starts.get(hash);
        if (start !== undefined) {
          starts.delete(hash);
          recordQuery(procedureName(query.queryKey), performance.now() - start);
        }
      }
    });
  }, [queryClient]);
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
