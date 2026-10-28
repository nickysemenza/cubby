import { problemsTypeSliceOut } from "@cubby/schemas/mcp";
import {
  allProblemsMcpSchema,
  referentialLivenessViolationsMcpOut,
} from "@cubby/schemas/problems";
import { assembleAllProblems } from "@cubby/schemas/problems-raw-read";
import { z } from "zod";

import { integrityProblemsContract } from "~/contracts/entity-integrity.contract";
import {
  problemReportWantsCounts,
  problemsContract,
  problemsStreamsContract,
} from "~/contracts/problems.contract";
import { readProblemCounts } from "~/server/generic/problems/operations/problem-counts.server";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import { implementSubscriptionDomain } from "~/server/operation-runtime/subscription-domain.server";

import { publicProblemGroups, publicProblemSlice } from "./problem-public-read";

// Load detector groups only for the operations that need them.
const problemWorkflows = () =>
  import("~/server/generic/problems/operations/problem-workflows.server");
const problemDetectors = () =>
  import("~/server/generic/problems/service/problems.service");
const problemExecution = () =>
  import("~/server/generic/problems/service/problem-execution.service");

/** Problem reads are authoritative so fixes disappear on the next fetch. */
export const problemsHandlers = implementOperationDomain(problemsContract, {
  getMaintenanceCounts: async (context) =>
    (await problemDetectors()).findMaintenanceCounts(context.db),
  dryRunReparse: async (context) =>
    (await problemDetectors()).dryRunReparse(context.db),
  dryRunPruneAliases: async (context) =>
    (await problemDetectors()).dryRunPruneAliases(context.db),
  deleteUnused: async (context, input) =>
    (await problemWorkflows()).deleteUnusedIngredientsWorkflow(context, input),
  resolveRunFinding: async (context, input) =>
    (
      await import("~/server/domains/purchase-import/repo/findings")
    ).resolveRunFinding(context.db, input, context.actorContext),
  resolveArrivedFindings: async (context, input) =>
    (
      await import("~/server/domains/purchase-import/repo/findings")
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
    if (input.type !== undefined) {
      const { expectedProblemKeys, problemQuery } =
        await import("~/entity/problems/problem-registry");
      const key = z.enum(expectedProblemKeys).safeParse(input.type);
      if (!key.success)
        return {
          error: `Unknown problem type '${input.type}'`,
          availableTypes: expectedProblemKeys,
        };
      const definition = problemQuery(key.data);
      if (!definition) throw new Error("Problem query registry is incomplete");
      const slice = await publicProblemSlice(
        context.db,
        await (
          await problemExecution()
        ).findProblemByType(
          context.db,
          definition.key,
          context.upcLookupClient,
          context.usdaClient,
        ),
        input,
      );
      return {
        ...projectProblemTypeSlice(slice),
        meta: {
          pageIndex: input.pageIndex,
          pageSize: input.pageSize,
          totalCount: slice.total,
          hasNextPage: (input.pageIndex + 1) * input.pageSize < slice.total,
        },
      };
    }
    const detectors = await problemDetectors();
    const [fast, coverage, upc, tracker, views] = await Promise.all([
      detectors.findFastProblems(context.db),
      detectors.findCoverageProblems(context.db, context.usdaClient),
      detectors.findUpcProblems(context.db, context.upcLookupClient),
      detectors.findTrackerProblems(context.db),
      import("~/server/generic/problems/service/problem-views.service").then(
        (views) => views.findViewProblems(context.db),
      ),
    ]);
    return publicProblemGroups(
      context.db,
      assembleAllProblems({ fast, coverage, upc, tracker, views }),
      allProblemsMcpSchema,
    );
  },
});

export function projectProblemTypeSlice(
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

export const integrityProblemsHandlers = implementOperationDomain(
  integrityProblemsContract,
  {
    getByType: async (context, input) =>
      integrityProblemsContract.ops.getByType.output.parse(
        await publicProblemSlice(
          context.db,
          await (
            await problemExecution()
          ).findProblemByType(
            context.db,
            input.key,
            context.upcLookupClient,
            context.usdaClient,
          ),
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
