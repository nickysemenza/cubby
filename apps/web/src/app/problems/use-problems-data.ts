import { useQueries } from "@tanstack/react-query";
import { sum } from "es-toolkit";
import { useTRPC } from "~/trpc/react";

/**
 * Loads the Problems page data as five cost-grouped tRPC queries instead of one
 * `getAllProblems` scan. Each group is routed through the unbatched link (see
 * root-provider.tsx), so it runs in its own Worker invocation / CPU budget —
 * the combined scan re-parsed every recipe line through WASM in two detectors
 * and intermittently blew the 30s CPU limit.
 *
 * The five group results are merged back into the same `AllProblems` shape the
 * section renderers expect (missing groups default to empty arrays while they
 * load), with `totalProblems` re-derived as the sum of section lengths. Uses
 * `useQueries` + `combine` for a referentially-stable result (per the repo's
 * hook-stability rule — a raw `useQueries` array is a new ref every render).
 */
export function useProblemsData() {
  const api = useTRPC();
  return useQueries({
    queries: [
      api.problems.getFast.queryOptions(),
      api.problems.getCoverage.queryOptions(),
      api.problems.getAliases.queryOptions(),
      api.problems.getParses.queryOptions(),
      api.problems.getUpc.queryOptions(),
    ],
    combine: ([fast, coverage, aliases, parses, upc]) => {
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
        ingredientsWithUnusedAliases:
          aliases.data?.ingredientsWithUnusedAliases ?? [],
        staleIngredientParses: parses.data?.staleIngredientParses ?? [],
        productsWithBetterUpcData: upc.data?.productsWithBetterUpcData ?? [],
      };
      const results = [fast, coverage, aliases, parses, upc];
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
