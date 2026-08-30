import {
  cleanupOrphanedEntityEmbeddingsInput,
  cleanupOrphanedEntityEmbeddingsOut,
  coverageTotalsSchema,
  deleteUnusedIngredientsInput,
  deleteUnusedIngredientsOut,
  dryRunPruneAliasesOut,
  dryRunReparseOut,
  maintenanceCountsSchema,
  problemsCountSchema,
  problemsCoverageSchema,
  problemsFastSchema,
  problemsPruneAliasesEventSchema,
  problemsReparseEventSchema,
  problemsTrackerSchema,
  problemsUpcSchema,
  problemsViewsSchema,
  recipeUsageByProductInput,
  recipeUsageByProductOut,
} from "@cubby/schemas/problems";
import { z } from "zod";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
  subscription,
} from "~/integrations/tanstack-query/operation-catalog";

const noInput = z.undefined();

export const problems = defineOperationDomain("problems", {
  getFast: query({
    input: noInput,
    output: problemsFastSchema,
    tags: [["problems", "getFast"]],
  }),
  getCounts: query({
    input: noInput,
    output: problemsCountSchema,
    tags: [["problems", "getCounts"]],
  }),
  getViews: query({
    input: noInput,
    output: problemsViewsSchema,
    tags: [["problems", "getViews"]],
  }),
  getCoverage: query({
    input: noInput,
    output: problemsCoverageSchema,
    tags: [["problems", "getCoverage"]],
  }),
  getUpc: query({
    input: noInput,
    output: problemsUpcSchema,
    tags: [["problems", "getUpc"]],
  }),
  getTracker: query({
    input: noInput,
    output: problemsTrackerSchema,
    tags: [["problems", "getTracker"]],
  }),
  getCoverageTotals: query({
    input: noInput,
    output: coverageTotalsSchema,
    tags: [["problems", "getCoverageTotals"]],
  }),
  getMaintenanceCounts: query({
    input: noInput,
    output: maintenanceCountsSchema,
    tags: [["problems", "getMaintenanceCounts"]],
  }),
  dryRunReparse: query({
    input: noInput,
    output: dryRunReparseOut,
    tags: [["problems", "dryRunReparse"]],
  }),
  dryRunPruneAliases: query({
    input: noInput,
    output: dryRunPruneAliasesOut,
    tags: [["problems", "dryRunPruneAliases"]],
  }),
  recipeUsageByProduct: query({
    input: recipeUsageByProductInput,
    output: recipeUsageByProductOut,
    tags: [["problems", "recipeUsageByProduct"]],
  }),
  deleteUnused: mutation({
    input: deleteUnusedIngredientsInput,
    output: deleteUnusedIngredientsOut,
    invalidates: ripple.ingredientCleanup,
  }),
  cleanupOrphanedEmbeddings: mutation({
    input: cleanupOrphanedEntityEmbeddingsInput,
    output: cleanupOrphanedEntityEmbeddingsOut,
    invalidates: ripple.problemsSearch,
  }),
});

export const problemsStreams = defineOperationDomain("problems", {
  reparseStale: subscription({
    input: noInput,
    event: problemsReparseEventSchema,
  }),
  pruneAllUnusedAliases: subscription({
    input: noInput,
    event: problemsPruneAliasesEventSchema,
  }),
});

export const openProblemsReparseStream = (signal?: AbortSignal) =>
  problemsStreams.reparseStale.open(undefined, { signal });
export const openProblemsPruneAliasesStream = (signal?: AbortSignal) =>
  problemsStreams.pruneAllUnusedAliases.open(undefined, { signal });
