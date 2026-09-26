import { integrityProblemsContract } from "~/contracts/entity-integrity.contract";
import {
  problemsContract,
  problemsStreamsContract,
} from "~/contracts/problems.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import { findProblemCountsWorkflow } from "~/server/workflows/problem-counts.server";

// The homepage counts read normally ends at the Durable Object. Keep the
// detector graph out of its cold path and load it only for other operations.
const problemWorkflows = () => import("~/server/workflows/problems.server");

/** Problem reads are authoritative so fixes disappear on the next fetch. */
export const problemsHandlers = implementOperationDomain(problemsContract, {
  getFast: {
    run: async (context) =>
      (await problemWorkflows()).findFastProblemsWorkflow(context),
  },
  getCounts: {
    run: (context) => findProblemCountsWorkflow(context),
  },
  getViews: {
    run: async (context) =>
      (await problemWorkflows()).findViewProblemsWorkflow(context),
  },
  getCoverage: {
    run: async (context) =>
      (await problemWorkflows()).findCoverageProblemsWorkflow(context),
  },
  getUpc: {
    run: async (context) =>
      (await problemWorkflows()).findUpcProblemsWorkflow(context),
  },
  getTracker: {
    run: async (context) =>
      (await problemWorkflows()).findTrackerProblemsWorkflow(context),
  },
  getCoverageTotals: {
    run: async (context) =>
      (await problemWorkflows()).findCoverageTotalsWorkflow(context),
  },
  getMaintenanceCounts: {
    run: async (context) =>
      (await problemWorkflows()).findMaintenanceCountsWorkflow(context),
  },
  dryRunReparse: {
    run: async (context) =>
      (await problemWorkflows()).dryRunReparseWorkflow(context),
  },
  dryRunPruneAliases: {
    run: async (context) =>
      (await problemWorkflows()).dryRunPruneAliasesWorkflow(context),
  },
  recipeUsageByProduct: {
    run: async (context, input) =>
      (await problemWorkflows()).recipeUsageByProductWorkflow(context, input),
  },
  deleteUnused: async (context, input) =>
    (await problemWorkflows()).deleteUnusedIngredientsWorkflow(context, input),
  resolveRunFinding: async (context, input) =>
    (await problemWorkflows()).resolveRunFindingWorkflow(context, input),
  resolveArrivedFindings: async (context, input) =>
    (await problemWorkflows()).resolveArrivedFindingsWorkflow(context, input),
});

export const integrityProblemsHandlers = implementOperationDomain(
  integrityProblemsContract,
  {
    getByType: {
      run: async (context, input) =>
        integrityProblemsContract.ops.getByType.output.parse(
          await (
            await problemWorkflows()
          ).findProblemByTypeWorkflow(context, input),
        ),
    },
  },
);

export const problemsStreamHandlers = implementSubscriptionDomain(
  problemsStreamsContract,
  {
    reparseStale: async (context, _input, signal) =>
      (await problemWorkflows()).reparseStaleWorkflow(
        context,
        undefined,
        signal,
      ),
    pruneAllUnusedAliases: async (context, _input, signal) =>
      (await problemWorkflows()).pruneAllUnusedAliasesWorkflow(
        context,
        undefined,
        signal,
      ),
  },
);
