import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { recordQuery } from "~/lib/perf/perf-store";

export interface LiveQueryStats {
  total: number;
  inFlight: number;
  mutationsPending: number;
}

/** tRPC query keys are `[["recipe","getByID"], input]` → "recipe.getByID". */
function procedureName(queryKey: unknown): string {
  const first = Array.isArray(queryKey) ? queryKey[0] : queryKey;
  if (Array.isArray(first)) return first.join(".");
  return String(first);
}

/**
 * Subscribes to the query + mutation caches to (a) return live counts and
 * (b) record per-procedure fetch durations into the perf store (also feeding the
 * fan-out detector). Cheap; only mounted while the overlay is open.
 */
export function useQueryStats(): LiveQueryStats {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<LiveQueryStats>({
    total: 0,
    inFlight: 0,
    mutationsPending: 0,
  });

  useEffect(() => {
    const queryCache = queryClient.getQueryCache();
    const mutationCache = queryClient.getMutationCache();
    const starts = new Map<string, number>(); // queryHash → fetch start time

    const recompute = () => {
      const queries = queryCache.getAll();
      const inFlight = queries.filter(
        (q) => q.state.fetchStatus === "fetching",
      ).length;
      const mutationsPending = mutationCache
        .getAll()
        .filter((m) => m.state.status === "pending").length;
      setLive({ total: queries.length, inFlight, mutationsPending });
    };

    const unsubQueries = queryCache.subscribe((event) => {
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
      recompute();
    });
    const unsubMutations = mutationCache.subscribe(recompute);
    recompute();

    return () => {
      unsubQueries();
      unsubMutations();
    };
  }, [queryClient]);

  return live;
}
