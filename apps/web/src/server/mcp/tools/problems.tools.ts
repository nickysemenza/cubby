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

import { getCaller, READ_ONLY_CLOSED, registerMcpTool } from "./_shared";

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

export function registerProblemsTools(server: McpServer) {
  registerMcpTool(server, {
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
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      if (
        params.countsOnly === true ||
        (params.countsOnly === undefined && params.type === undefined)
      ) {
        return await caller.problems.getCounts();
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
        const slice = projectProblemTypeSlice(
          await caller.problems.getByType({ key: definition.key }),
        );
        const start = params.pageIndex * params.pageSize;
        return {
          ...slice,
          items: slice.items.slice(start, start + params.pageSize),
          meta: {
            pageIndex: params.pageIndex,
            pageSize: params.pageSize,
            totalCount: slice.total,
          },
        };
      }
      const [fast, coverage, upc, tracker, views] = await Promise.all([
        caller.problems.getFast(),
        caller.problems.getCoverage(),
        caller.problems.getUpc(),
        caller.problems.getTracker(),
        caller.problems.getViews(),
      ]);
      const all = assembleAllProblems({ fast, coverage, upc, tracker, views });
      return allProblemsMcpSchema.parse(all);
    },
  });
}
