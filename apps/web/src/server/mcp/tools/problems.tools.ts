import {
  problemsCountSchema,
  problemsTypeSliceOut,
  problemsUnknownTypeOut,
} from "@cubby/schemas/mcp";
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
          "Return only per-type counts and a total, not the full lists",
        ),
      type: z
        .string()
        .optional()
        .describe(
          "Return only this problem category (e.g. 'orphanedProducts'). Ignored when countsOnly is true.",
        ),
    }),
    outputSchema: z.union([
      problemsCountSchema,
      allProblemsMcpSchema,
      problemsTypeSliceOut,
      problemsUnknownTypeOut,
    ]),
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      if (params.countsOnly) {
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
        return projectProblemTypeSlice(
          await caller.problems.getByType({ key: definition.key }),
        );
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
