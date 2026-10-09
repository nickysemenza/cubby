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

// Heavy library: the detector graph reaches WASM, and the homepage counts read
// (the common call) ends at the Durable Object without it.
const problemReports = () => import("./problem-reports.server");

/** Problem reads are authoritative so fixes disappear on the next fetch. */
export const problemsHandlers = implementOperationDomain(problemsContract, {
  getFast: async (context) =>
    (await problemReports()).findFastProblems(context.db),
  getCounts: (context) => readProblemCounts(context),
  getViews: async (context) =>
    (await problemReports()).findViewProblems(context.db),
  getCoverage: async (context) =>
    (await problemReports()).findCoverageProblems(
      context.db,
      context.usdaClient,
    ),
  getUpc: async (context) =>
    (await problemReports()).findUpcProblems(
      context.db,
      context.upcLookupClient,
    ),
  getTracker: async (context) =>
    (await problemReports()).findTrackerProblems(context.db),
  getCoverageTotals: async (context) =>
    (await problemReports()).findCoverageTotals(context.db),
  getMaintenanceCounts: async (context) =>
    (await problemReports()).findMaintenanceCounts(context.db),
  dryRunReparse: async (context) =>
    (await problemReports()).dryRunReparse(context.db),
  dryRunPruneAliases: async (context) =>
    (await problemReports()).dryRunPruneAliases(context.db),
  recipeUsageByProduct: async (context, input) =>
    (await problemReports()).recipeUsageCountsByProduct(
      context.db,
      input.productShortcodes,
    ),
  deleteUnused: async (context, input) =>
    (await problemReports()).deleteUnusedIngredientsWorkflow(context, input),
  resolveRunFinding: async (context, input) =>
    (await problemReports()).resolveRunFinding(
      context.db,
      input,
      context.actorContext,
      context.services.recipeCosting,
    ),
  resolveArrivedFindings: async (context, input) =>
    (await problemReports()).resolveArrivedFindingsForPurchase(
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
    const detectors = await problemReports();
    if (input.type !== undefined) {
      const { expectedProblemKeys, problemQuery } = detectors;
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
      detectors.findViewProblems(context.db),
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
          await problemReports()
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
      (await problemReports()).reparseStaleWorkflow(context, undefined, signal),
    pruneAllUnusedAliases: async (context, _input, signal) =>
      (await problemReports()).pruneAllUnusedAliasesWorkflow(
        context,
        undefined,
        signal,
      ),
  },
);
