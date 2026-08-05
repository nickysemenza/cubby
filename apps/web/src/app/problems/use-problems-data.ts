import { sumProblemSections } from "@cubby/schemas/problems";
import { useQueries } from "@tanstack/react-query";
import { useTRPC } from "~/integrations/trpc/react";
import type { ProblemsHotPathProcedure } from "~/lib/problems-query-groups";

/**
 * Loads the Problems page data as four cost-grouped tRPC queries instead of one
 * `getAllProblems` scan. Each group is routed through the unbatched link (see
 * root-provider.tsx), so it runs in its own Worker invocation / CPU budget —
 * the combined scan re-parsed every recipe line through WASM and intermittently
 * blew the 30s CPU limit. (The two WASM parse-sweeps it used to include now live
 * as manual Settings → Maintenance actions, off this hot path.)
 *
 * The four group results are merged back into the same `AllProblems` shape the
 * section renderers expect (missing groups default to empty arrays while they
 * load), with `totalProblems` re-derived via the shared `sumProblemSections` —
 * DEFECT sections only, matching `assembleAllProblems`. Coverage sections (see
 * `PROBLEM_CLASS`) are summed separately into `coverageTotal`; folding them into
 * one number is what made the badge permanently red and unactionable. Uses
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
    getTracker: {
      ...api.problems.getTracker.queryOptions(),
      staleTime,
      enabled,
    },
  } satisfies Record<ProblemsHotPathProcedure, unknown>;
  return useQueries({
    queries: [
      problemGroupQueries.getFast,
      problemGroupQueries.getCoverage,
      problemGroupQueries.getUpc,
      problemGroupQueries.getTracker,
    ],
    combine: ([fast, coverage, upc, tracker]) => {
      const sections = {
        duplicateInventory: fast.data?.duplicateInventory ?? [],
        duplicateProductIdentities: fast.data?.duplicateProductIdentities ?? [],
        orphanedProducts: fast.data?.orphanedProducts ?? [],
        productsMissingPrice: fast.data?.productsMissingPrice ?? [],
        unvaluedBucketProducts: fast.data?.unvaluedBucketProducts ?? [],
        soldButStillStocked: fast.data?.soldButStillStocked ?? [],
        negativeExpectedQuantity: fast.data?.negativeExpectedQuantity ?? [],
        toolsUsedOutsideOwnership: fast.data?.toolsUsedOutsideOwnership ?? [],
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
        orphanedEntityEmbeddings: fast.data?.orphanedEntityEmbeddings ?? [],
        entitiesMissingEmbeddings: fast.data?.entitiesMissingEmbeddings ?? [],
        staleParentRecipes: fast.data?.staleParentRecipes ?? [],
        staleLocations: fast.data?.staleLocations ?? [],
        neverVerifiedInventory: fast.data?.neverVerifiedInventory ?? [],
        unknownParkedItems: fast.data?.unknownParkedItems ?? [],
        manufacturerSpellingVariants:
          fast.data?.manufacturerSpellingVariants ?? [],
        duplicateVendors: fast.data?.duplicateVendors ?? [],
        vendorsWithoutLogos: fast.data?.vendorsWithoutLogos ?? [],
        purchasesNotReconciling: fast.data?.purchasesNotReconciling ?? [],
        purchaseFinancialSettlementMismatches:
          fast.data?.purchaseFinancialSettlementMismatches ?? [],
        duplicateSpendCandidates: fast.data?.duplicateSpendCandidates ?? [],
        duplicateFinancialTransactionSourceRefs:
          fast.data?.duplicateFinancialTransactionSourceRefs ?? [],
        duplicateFinancialAccountSourceAliases:
          fast.data?.duplicateFinancialAccountSourceAliases ?? [],
        invalidFinancialJson: fast.data?.invalidFinancialJson ?? [],
        referentialLivenessViolations:
          fast.data?.referentialLivenessViolations ?? [],
        ingredientsWithPartialCoverage:
          coverage.data?.ingredientsWithPartialCoverage ?? [],
        productsWithIslandedMappings:
          coverage.data?.productsWithIslandedMappings ?? [],
        productsWithBetterUpcData: upc.data?.productsWithBetterUpcData ?? [],
        overdueTasks: tracker.data?.overdueTasks ?? [],
        stalledProjects: tracker.data?.stalledProjects ?? [],
        projectsMissingBudget: tracker.data?.projectsMissingBudget ?? [],
        pastDuePlannedExpenses: tracker.data?.pastDuePlannedExpenses ?? [],
        unclassifiedExpenses: tracker.data?.unclassifiedExpenses ?? [],
        blockedWorkProjects: tracker.data?.blockedWorkProjects ?? [],
        projectsWithDateDrift: tracker.data?.projectsWithDateDrift ?? [],
      };
      const results = [fast, coverage, upc, tracker];
      return {
        problems: {
          ...sections,
          // Defect sections only — must match `assembleAllProblems`, hence the
          // shared helper rather than a second local sum.
          totalProblems: sumProblemSections(sections, "defect"),
        },
        coverageTotal: sumProblemSections(sections, "coverage"),
        isLoading: results.some((r) => r.isLoading),
        error: results.find((r) => r.error)?.error ?? null,
      };
    },
  });
}
