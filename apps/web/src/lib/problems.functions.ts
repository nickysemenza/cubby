import {
  problemsContract,
  problemsStreamsContract,
} from "~/contracts/problems.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const problems = defineOperationDomain(problemsContract, {
  getFast: { tags: [["problems", "getFast"]] },
  getCounts: { tags: [["problems", "getCounts"]], cache: "stable" },
  getViews: { tags: [["problems", "getViews"]] },
  getCoverage: { tags: [["problems", "getCoverage"]] },
  getUpc: { tags: [["problems", "getUpc"]] },
  getTracker: { tags: [["problems", "getTracker"]] },
  getCoverageTotals: { tags: [["problems", "getCoverageTotals"]] },
  getMaintenanceCounts: {
    tags: [["problems", "getMaintenanceCounts"]],
    cache: "stable",
  },
  dryRunReparse: { tags: [["problems", "dryRunReparse"]] },
  dryRunPruneAliases: { tags: [["problems", "dryRunPruneAliases"]] },
  recipeUsageByProduct: { tags: [["problems", "recipeUsageByProduct"]] },
  deleteUnused: { invalidates: ripple.ingredientCleanup },
  resolveRunFinding: { invalidates: ripple.problems },
  resolveArrivedFindings: { invalidates: ripple.problems },
});

export const problemsStreams = defineOperationDomain(problemsStreamsContract);

export const openProblemsReparseStream = (signal?: AbortSignal) =>
  problemsStreams.reparseStale.open(undefined, { signal });
export const openProblemsPruneAliasesStream = (signal?: AbortSignal) =>
  problemsStreams.pruneAllUnusedAliases.open(undefined, { signal });
