import { useQueries } from "@tanstack/react-query";
import { sum } from "es-toolkit";
import type { ProblemsHotPathProcedure } from "~/lib/problems-query-groups";
import { useTRPC } from "~/trpc/react";

/**
 * Loads the Problems page data as three cost-grouped tRPC queries instead of one
 * `getAllProblems` scan. Each group is routed through the unbatched link (see
 * root-provider.tsx), so it runs in its own Worker invocation / CPU budget —
 * the combined scan re-parsed every recipe line through WASM and intermittently
 * blew the 30s CPU limit. (The two WASM parse-sweeps it used to include now live
 * as manual Settings → Maintenance actions, off this hot path.)
 *
 * The three group results are merged back into the same `AllProblems` shape the
 * section renderers expect (missing groups default to empty arrays while they
 * load), with `totalProblems` re-derived as the sum of section lengths. Uses
 * `useQueries` + `combine` for a referentially-stable result (per the repo's
 * hook-stability rule — a raw `useQueries` array is a new ref every render).
 */
export function useProblemsData(opts?: {
  staleTime?: number;
  enabled?: boolean;
}) {
  const api = useTRPC();
  // `staleTime` lets the navbar badge reuse this exact cache with a relaxed
  // 5-min freshness (background indicator) while the page leaves it at the
  // client default and revalidates on entry — same query keys, one shared scan.
  // `enabled` lets the homepage card gate the fetch (SSR-idle, then enable on
  // the client) to avoid a hydration mismatch, like the sibling stat cards.
  const staleTime = opts?.staleTime;
  const enabled = opts?.enabled;
  const problemGroupQueries = {
    getFast: { ...api.problems.getFast.queryOptions(), staleTime, enabled },
    getCoverage: {
      ...api.problems.getCoverage.queryOptions(),
      staleTime,
      enabled,
    },
    getUpc: { ...api.problems.getUpc.queryOptions(), staleTime, enabled },
  } satisfies Record<ProblemsHotPathProcedure, unknown>;
  return useQueries({
    queries: [
      problemGroupQueries.getFast,
      problemGroupQueries.getCoverage,
      problemGroupQueries.getUpc,
    ],
    combine: ([fast, coverage, upc]) => {
      const sections = {
        duplicateUniqueProducts: fast.data?.duplicateUniqueProducts ?? [],
        orphanedProducts: fast.data?.orphanedProducts ?? [],
        productsWithoutMappings: fast.data?.productsWithoutMappings ?? [],
        ingredientsWithoutProduct: fast.data?.ingredientsWithoutProduct ?? [],
        unusedIngredientsWithProduct:
          fast.data?.unusedIngredientsWithProduct ?? [],
        unusedIngredientsWithoutProduct:
          fast.data?.unusedIngredientsWithoutProduct ?? [],
        emptyLocations: fast.data?.emptyLocations ?? [],
        productsWithNoImages: fast.data?.productsWithNoImages ?? [],
        locationsWithoutAiDescription:
          fast.data?.locationsWithoutAiDescription ?? [],
        ingredientsWithPartialCoverage:
          coverage.data?.ingredientsWithPartialCoverage ?? [],
        productsWithIslandedMappings:
          coverage.data?.productsWithIslandedMappings ?? [],
        productsWithBetterUpcData: upc.data?.productsWithBetterUpcData ?? [],
      };
      const results = [fast, coverage, upc];
      return {
        problems: {
          ...sections,
          totalProblems: sum(
            Object.values(sections).map((items) => items.length),
          ),
        },
        isLoading: results.some((r) => r.isLoading),
        error: results.find((r) => r.error)?.error ?? null,
      };
    },
  });
}
