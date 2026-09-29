import {
  problemsTypeSliceOut,
  problemsUnknownTypeOut,
} from "@cubby/schemas/mcp";
import { mcpPaginationFields } from "@cubby/schemas/pagination";
import {
  allProblemsMcpSchema,
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
  /**
   * Counts, one paged problem type, or the complete report (MCP `activity`).
   * Counts are the snapshot computation and keep its authoritative detector
   * reads; a requested type is a paged detail read.
   */
  report: query({
    http: false,
    input: z.object({
      countsOnly: z
        .boolean()
        .optional()
        .describe(
          "Defaults to counts when no type is supplied. Set false without a type for the complete report; true always returns counts.",
        ),
      type: z
        .string()
        .optional()
        .describe(
          "Return only this problem category (e.g. 'orphanedProducts'). Ignored when countsOnly is true.",
        ),
      ...mcpPaginationFields({ defaultPageSize: 25, maxPageSize: 100 }),
    }),
    output: z.union([
      problemsCountSchema,
      allProblemsMcpSchema,
      problemsTypeSliceOut,
      problemsUnknownTypeOut,
    ]),
  }),
});

/** Whether a `report` call is the counts read rather than a detail read. */
export const problemReportWantsCounts = (input: {
  countsOnly?: boolean;
  type?: string;
}) =>
  input.countsOnly === true ||
  (input.countsOnly === undefined && input.type === undefined);

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
