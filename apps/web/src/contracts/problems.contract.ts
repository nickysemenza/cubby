import {
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
  resolveArrivedFindingsInput,
  resolveArrivedFindingsOut,
  resolveImportFindingInput,
  resolveImportFindingOut,
} from "@cubby/schemas/problems";
import { z } from "zod";

import {
  defineContract,
  mutation,
  query,
  subscription,
} from "~/contracts/define";

const noInput = z.undefined();

export const problemsContract = defineContract("problems", {
  getFast: query({
    input: noInput,
    output: problemsFastSchema,
  }),
  getCounts: query({
    native: "Today problems tile",
    input: noInput,
    output: problemsCountSchema,
  }),
  getViews: query({
    input: noInput,
    output: problemsViewsSchema,
  }),
  getCoverage: query({
    input: noInput,
    output: problemsCoverageSchema,
  }),
  getUpc: query({
    input: noInput,
    output: problemsUpcSchema,
  }),
  getTracker: query({
    input: noInput,
    output: problemsTrackerSchema,
  }),
  getCoverageTotals: query({
    input: noInput,
    output: coverageTotalsSchema,
  }),
  getMaintenanceCounts: query({
    input: noInput,
    output: maintenanceCountsSchema,
  }),
  dryRunReparse: query({
    input: noInput,
    output: dryRunReparseOut,
  }),
  dryRunPruneAliases: query({
    input: noInput,
    output: dryRunPruneAliasesOut,
  }),
  recipeUsageByProduct: query({
    input: recipeUsageByProductInput,
    output: recipeUsageByProductOut,
  }),
  deleteUnused: mutation({
    input: deleteUnusedIngredientsInput,
    output: deleteUnusedIngredientsOut,
  }),
  resolveImportFinding: mutation({
    input: resolveImportFindingInput,
    output: resolveImportFindingOut,
  }),
  resolveArrivedFindings: mutation({
    input: resolveArrivedFindingsInput,
    output: resolveArrivedFindingsOut,
  }),
});

export const problemsStreamsContract = defineContract("problems", {
  reparseStale: subscription({
    input: noInput,
    event: problemsReparseEventSchema,
  }),
  pruneAllUnusedAliases: subscription({
    input: noInput,
    event: problemsPruneAliasesEventSchema,
  }),
});
