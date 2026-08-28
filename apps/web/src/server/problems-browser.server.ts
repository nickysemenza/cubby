import { integrityProblems } from "~/entities/entity-integrity.functions";
import { problems, problemsStreams } from "~/lib/problems.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  cleanupOrphanedEmbeddingsWorkflow,
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
  reparseStaleWorkflow,
} from "~/server/workflows/problems.server";

/** Problem reads are authoritative so fixes disappear on the next fetch. */
export const problemsHandlers = implementOperationDomain(problems, {
  getFast: {
    readPolicy: "strong",
    run: (context) => findFastProblemsWorkflow(context),
  },
  getCounts: {
    readPolicy: "strong",
    run: (context) => findProblemCountsWorkflow(context),
  },
  getViews: {
    readPolicy: "strong",
    run: (context) => findViewProblemsWorkflow(context),
  },
  getCoverage: {
    readPolicy: "strong",
    run: (context) => findCoverageProblemsWorkflow(context),
  },
  getUpc: {
    readPolicy: "strong",
    run: (context) => findUpcProblemsWorkflow(context),
  },
  getTracker: {
    readPolicy: "strong",
    run: (context) => findTrackerProblemsWorkflow(context),
  },
  getCoverageTotals: {
    readPolicy: "strong",
    run: (context) => findCoverageTotalsWorkflow(context),
  },
  getMaintenanceCounts: {
    readPolicy: "strong",
    run: (context) => findMaintenanceCountsWorkflow(context),
  },
  dryRunReparse: {
    readPolicy: "strong",
    run: (context) => dryRunReparseWorkflow(context),
  },
  dryRunPruneAliases: {
    readPolicy: "strong",
    run: (context) => dryRunPruneAliasesWorkflow(context),
  },
  recipeUsageByProduct: {
    readPolicy: "strong",
    run: (context, input) => recipeUsageByProductWorkflow(context, input),
  },
  deleteUnused: (context, input) =>
    deleteUnusedIngredientsWorkflow(context, input),
  cleanupOrphanedEmbeddings: (context, input) =>
    cleanupOrphanedEmbeddingsWorkflow(context, input),
});

export const integrityProblemsHandlers = implementOperationDomain(
  integrityProblems,
  {
    getByType: {
      readPolicy: "strong",
      run: async (context, input) =>
        integrityProblems.getByType.definition.output.parse(
          await findProblemByTypeWorkflow(context, input),
        ),
    },
  },
);

export const problemsStreamHandlers = implementSubscriptionDomain(
  problemsStreams,
  {
    reparseStale: (context) => reparseStaleWorkflow(context),
    pruneAllUnusedAliases: (context) => pruneAllUnusedAliasesWorkflow(context),
  },
);
