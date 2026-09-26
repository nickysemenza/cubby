import {
  problemsCountSchema,
  problemsTypeSliceOut,
  problemsUnknownTypeOut,
} from "@cubby/schemas/mcp";
import { mcpPaginationFields } from "@cubby/schemas/pagination";
import {
  allProblemsMcpSchema,
  assembleAllProblems,
  referentialLivenessViolationsMcpOut,
} from "@cubby/schemas/problems";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { expectedProblemKeys, problemQuery } from "~/entities/problem-registry";
import { findProblemCountsWorkflow } from "~/server/workflows/problem-counts.server";
import {
  findCoverageProblemsWorkflow,
  findFastProblemsWorkflow,
  findProblemByTypeWorkflow,
  findTrackerProblemsWorkflow,
  findUpcProblemsWorkflow,
  findViewProblemsWorkflow,
} from "~/server/workflows/problems.server";

import { READ_ONLY_CLOSED, registerRouterTool } from "./_shared";

const problemKeySchema = z.enum(expectedProblemKeys);

function projectProblemTypeSlice(
  value: z.input<typeof problemsTypeSliceOut>,
): z.output<typeof problemsTypeSliceOut> {
  const slice = problemsTypeSliceOut.parse(value);
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
  value: z.input<typeof problemsTypeSliceOut>,
  page: { pageIndex: number; pageSize: number },
) {
  const slice = projectProblemTypeSlice(value);
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

export function registerProblemsTools(server: McpServer) {
  registerRouterTool(server, {
    name: "list_problems",
    description:
      "List data-quality problems and optional coverage backlogs across products, inventory, locations, recipes, and vendors, plus household-tracker items needing attention (overdue tasks, stalled/blocked projects, past-due planned expenses, missing budgets, unclassified expenses).",
    inputSchema: z.object({
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
    outputSchema: z.union([
      problemsCountSchema,
      allProblemsMcpSchema,
      problemsTypeSliceOut,
      problemsUnknownTypeOut,
    ]),
    annotations: READ_ONLY_CLOSED,
    // Counts are the KV snapshot computation and retain its authoritative
    // detector reads; a requested type is a paged detail read unless counts
    // were explicitly requested.
    readPolicy: (params) =>
      params.countsOnly === true ||
      (params.countsOnly === undefined && params.type === undefined)
        ? "strong"
        : "context",
    call: async (context, params) => {
      if (
        params.countsOnly === true ||
        (params.countsOnly === undefined && params.type === undefined)
      ) {
        return await findProblemCountsWorkflow(context);
      }
      if (params.type !== undefined) {
        const parsedProblemKey = problemKeySchema.safeParse(params.type);
        if (!parsedProblemKey.success) {
          return {
            error: `Unknown problem type '${params.type}'`,
            availableTypes: expectedProblemKeys,
          };
        }
        const definition = problemQuery(parsedProblemKey.data);
        if (!definition)
          throw new Error("Problem query registry is incomplete");
        return pageProblemTypeSlice(
          await findProblemByTypeWorkflow(context, { key: definition.key }),
          params,
        );
      }
      const [fast, coverage, upc, tracker, views] = await Promise.all([
        findFastProblemsWorkflow(context),
        findCoverageProblemsWorkflow(context),
        findUpcProblemsWorkflow(context),
        findTrackerProblemsWorkflow(context),
        findViewProblemsWorkflow(context),
      ]);
      const all = assembleAllProblems({ fast, coverage, upc, tracker, views });
      return allProblemsMcpSchema.parse(all);
    },
  });
}
