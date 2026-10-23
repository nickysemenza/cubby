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

export const problemsContract = defineContract(
  "problems",
  {
    getFast: query({
      input: noInput,
      output: problemsFastSchema,
    }),
    getCounts: query({
      readPolicy: "strong",
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
      exposure: "capability",
      description:
        "Preview which retained records would change if the selected parser data were reparsed. This is read-only; inspect the candidates before requesting a repair.",
      readPolicy: "strong",
      input: noInput,
      output: dryRunReparseOut,
    }),
    // Integrity/repair diagnostics.
    dryRunPruneAliases: query({
      exposure: "capability",
      description:
        "Preview aliases that are safe to prune from the selected entities. This is read-only and reports the rows that delete_unused would remove.",
      readPolicy: "strong",
      input: noInput,
      output: dryRunPruneAliasesOut,
    }),
    recipeUsageByProduct: query({
      input: recipeUsageByProductInput,
      output: recipeUsageByProductOut,
    }),
    deleteUnused: mutation({
      exposure: "capability",
      description:
        "Delete unused records selected by the declared cleanup rules. Review dry_run_prune_aliases or the matching preview first; this is a destructive cleanup.",
      destructive: true,
      input: deleteUnusedIngredientsInput,
      output: deleteUnusedIngredientsOut,
      invalidates: ["ingredientCleanup"],
    }),
    resolveRunFinding: mutation({
      exposure: "capability",
      description:
        "Apply or dismiss one Run finding by id; apply requires its reviewedFingerprint when it carries one.",
      command: {
        label: "Resolve finding",
        confirmation: null,
        success: "Import finding resolved",
      },
      input: resolveRunFindingInput,
      output: resolveRunFindingOut,
      invalidates: [
        "problems",
        "runOnly",
        "purchase",
        "expense",
        "financialTransaction",
      ],
    }),
    resolveArrivedFindings: mutation({
      exposure: "capability",
      note: "Closes a Purchase's arrived finding once receiving lands",
      description:
        "Resolve arrived-Purchase findings after the corresponding inventory receipt has been recorded. This closes findings; it does not receive stock.",
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
      exposure: "capability",
      description:
        'Data-quality problems and optional coverage backlogs across products, inventory, locations, recipes, and vendors, plus household-tracker items needing attention (overdue tasks, stalled/blocked projects, past-due planned expenses, missing budgets, unclassified expenses). countsOnly=true is the cheap triage; type="duplicateInventory" finds unique Products stored in more than one location; type="purchasesNotReconciling" holds only the unexplained Purchase differences.',
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
  },
  { exposure: "view", mcpToolGroup: "activity" },
);

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
