import { problemsTypeSliceOut } from "@cubby/schemas/mcp";
import {
  allProblemsMcpSchema,
  assembleAllProblems,
  referentialLivenessViolationsMcpOut,
} from "@cubby/schemas/problems";
import { z } from "zod";

import { integrityProblemsContract } from "~/contracts/entity-integrity.contract";
import {
  problemReportWantsCounts,
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
    (
      await import("~/server/repo/problems/detectors-product")
    ).recipeUsageCountsByProduct(context.db, input.productShortcodes),
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
  report: async (context, input) => {
    if (problemReportWantsCounts(input)) return readProblemCounts(context);
    const detectors = await problemDetectors();
    if (input.type !== undefined) {
      const { expectedProblemKeys, problemQuery } =
        await import("~/entities/problem-registry");
      const key = z.enum(expectedProblemKeys).safeParse(input.type);
      if (!key.success)
        return {
          error: `Unknown problem type '${input.type}'`,
          availableTypes: expectedProblemKeys,
        };
      const definition = problemQuery(key.data);
      if (!definition) throw new Error("Problem query registry is incomplete");
      return pageProblemTypeSlice(
        await detectors.findProblemByType(
          context.db,
          definition.key,
          context.upcLookupClient,
          context.usdaClient,
        ),
        input,
      );
    }
    const [fast, coverage, upc, tracker, views] = await Promise.all([
      detectors.findFastProblems(context.db),
      detectors.findCoverageProblems(context.db, context.usdaClient),
      detectors.findUpcProblems(context.db, context.upcLookupClient),
      detectors.findTrackerProblems(context.db),
      import("~/server/services/problem-views.service").then((views) =>
        views.findViewProblems(context.db),
      ),
    ]);
    return allProblemsMcpSchema.parse(
      assembleAllProblems({ fast, coverage, upc, tracker, views }),
    );
  },
});

function projectProblemTypeSlice(
  slice: z.output<typeof problemsTypeSliceOut>,
): z.output<typeof problemsTypeSliceOut> {
  switch (slice.type) {
    case "referentialLivenessViolations":
      return problemsTypeSliceOut.parse({
        ...slice,
        items: referentialLivenessViolationsMcpOut.parse(slice.items),
      });
    default:
      return slice;
  }
}

/** One page of a problem-type report, with internal diagnostic ids projected out. */
export function pageProblemTypeSlice(
  value: unknown,
  page: { pageIndex: number; pageSize: number },
) {
  const slice = projectProblemTypeSlice(problemsTypeSliceOut.parse(value));
  const start = page.pageIndex * page.pageSize;
  return {
    ...slice,
    items: slice.items.slice(start, start + page.pageSize),
    meta: {
      pageIndex: page.pageIndex,
      pageSize: page.pageSize,
      totalCount: slice.total,
    },
  };
}

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
