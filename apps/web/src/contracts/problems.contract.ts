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
  resolveRunFindingInput,
  resolveRunFindingOut,
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
    readPolicy: "strong",
    native: "Today problems tile",
    input: noInput,
    output: problemsCountSchema,
    cache: { profile: "stable" },
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
    readPolicy: "strong",
    input: noInput,
    output: maintenanceCountsSchema,
    cache: { profile: "stable" },
  }),
  dryRunReparse: query({
    readPolicy: "strong",
    input: noInput,
    output: dryRunReparseOut,
  }),
  // Integrity/repair diagnostics.
  dryRunPruneAliases: query({
    readPolicy: "strong",
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
    invalidates: ["ingredientCleanup"],
  }),
  resolveRunFinding: mutation({
    input: resolveRunFindingInput,
    output: resolveRunFindingOut,
    invalidates: ["problems"],
  }),
  resolveArrivedFindings: mutation({
    input: resolveArrivedFindingsInput,
    output: resolveArrivedFindingsOut,
    invalidates: ["problems"],
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
