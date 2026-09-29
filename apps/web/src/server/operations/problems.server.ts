import { integrityProblemsContract } from "~/contracts/entity-integrity.contract";
import {
  problemsContract,
  problemsStreamsContract,
} from "~/contracts/problems.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { readProblemCounts } from "~/server/operations/problem-counts.server";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";

// The homepage counts read normally ends at the Durable Object. Keep the
// detector graph out of its cold path: every module below is imported only by
// the operations that need it.
const problemWorkflows = () =>
  import("~/server/operations/problem-workflows.server");
const problemDetectors = () => import("~/server/services/problems.service");

/** Problem reads are authoritative so fixes disappear on the next fetch. */
export const problemsHandlers = implementOperationDomain(problemsContract, {
  getFast: async (context) =>
    (await problemDetectors()).findFastProblems(context.db),
  getCounts: (context) => readProblemCounts(context),
  getViews: async (context) =>
    (await import("~/server/services/problem-views.service")).findViewProblems(
      context.db,
    ),
  getCoverage: async (context) =>
    (await problemDetectors()).findCoverageProblems(
      context.db,
      context.usdaClient,
    ),
  getUpc: async (context) =>
    (await problemDetectors()).findUpcProblems(
      context.db,
      context.upcLookupClient,
    ),
  getTracker: async (context) =>
    (await problemDetectors()).findTrackerProblems(context.db),
  getCoverageTotals: async (context) =>
    (await problemDetectors()).findCoverageTotals(context.db),
  getMaintenanceCounts: async (context) =>
    (await problemDetectors()).findMaintenanceCounts(context.db),
  dryRunReparse: async (context) =>
    (await problemDetectors()).dryRunReparse(context.db),
  dryRunPruneAliases: async (context) =>
    (await problemDetectors()).dryRunPruneAliases(context.db),
  recipeUsageByProduct: async (context, input) =>
    (await import("~/server/repo/problems")).recipeUsageCountsByProduct(
      context.db,
      input.productShortcodes,
    ),
  deleteUnused: async (context, input) =>
    (await problemWorkflows()).deleteUnusedIngredientsWorkflow(context, input),
  resolveRunFinding: async (context, input) =>
    (await import("~/server/purchase-import/findings")).resolveRunFinding(
      context.db,
      input,
      context.actorContext,
    ),
  resolveArrivedFindings: async (context, input) =>
    (
      await import("~/server/purchase-import/findings")
    ).resolveArrivedFindingsForPurchase(
      context.db,
      {
        purchaseId: await resolveOrThrow(
          context.db,
          "purchase",
          input.purchaseId,
        ),
      },
      context.actorContext,
    ),
});

export const integrityProblemsHandlers = implementOperationDomain(
  integrityProblemsContract,
  {
    getByType: async (context, input) =>
      integrityProblemsContract.ops.getByType.output.parse(
        await (
          await problemDetectors()
        ).findProblemByType(
          context.db,
          input.key,
          context.upcLookupClient,
          context.usdaClient,
        ),
      ),
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
