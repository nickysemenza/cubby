import { integrityProblemsContract } from "~/contracts/entity-integrity.contract";
import {
  problemsContract,
  problemsStreamsContract,
} from "~/contracts/problems.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  deleteUnusedIngredientsWorkflow,
  dryRunPruneAliasesWorkflow,
  dryRunReparseWorkflow,
  findCoverageProblemsWorkflow,
  findCoverageTotalsWorkflow,
  findFastProblemsWorkflow,
  findMaintenanceCountsWorkflow,
  findProblemByTypeWorkflow,
  findProblemCountsWorkflow,
  findTrackerProblemsWorkflow,
  findUpcProblemsWorkflow,
  findViewProblemsWorkflow,
  pruneAllUnusedAliasesWorkflow,
  recipeUsageByProductWorkflow,
  resolveArrivedFindingsWorkflow,
  resolveImportFindingWorkflow,
  reparseStaleWorkflow,
} from "~/server/workflows/problems.server";

/** Problem reads are authoritative so fixes disappear on the next fetch. */
export const problemsHandlers = implementOperationDomain(problemsContract, {
  getFast: {
    run: (context) => findFastProblemsWorkflow(context),
  },
  getCounts: {
    run: (context) => findProblemCountsWorkflow(context),
  },
  getViews: {
    run: (context) => findViewProblemsWorkflow(context),
  },
  getCoverage: {
    run: (context) => findCoverageProblemsWorkflow(context),
  },
  getUpc: {
    run: (context) => findUpcProblemsWorkflow(context),
  },
  getTracker: {
    run: (context) => findTrackerProblemsWorkflow(context),
  },
  getCoverageTotals: {
    run: (context) => findCoverageTotalsWorkflow(context),
  },
  getMaintenanceCounts: {
    run: (context) => findMaintenanceCountsWorkflow(context),
  },
  dryRunReparse: {
    run: (context) => dryRunReparseWorkflow(context),
  },
  dryRunPruneAliases: {
    run: (context) => dryRunPruneAliasesWorkflow(context),
  },
  recipeUsageByProduct: {
    run: (context, input) => recipeUsageByProductWorkflow(context, input),
  },
  deleteUnused: (context, input) =>
    deleteUnusedIngredientsWorkflow(context, input),
  resolveImportFinding: (context, input) =>
    resolveImportFindingWorkflow(context, input),
  resolveArrivedFindings: (context, input) =>
    resolveArrivedFindingsWorkflow(context, input),
});

export const integrityProblemsHandlers = implementOperationDomain(
  integrityProblemsContract,
  {
    getByType: {
      run: async (context, input) =>
        integrityProblemsContract.ops.getByType.output.parse(
          await findProblemByTypeWorkflow(context, input),
        ),
    },
  },
);

export const problemsStreamHandlers = implementSubscriptionDomain(
  problemsStreamsContract,
  {
    reparseStale: (context, _input, signal) =>
      reparseStaleWorkflow(context, undefined, signal),
    pruneAllUnusedAliases: (context, _input, signal) =>
      pruneAllUnusedAliasesWorkflow(context, undefined, signal),
  },
);
