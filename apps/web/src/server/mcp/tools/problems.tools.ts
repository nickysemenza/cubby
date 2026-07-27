import {
  allProblemsSchema,
  problemsCountSchema,
  problemsTypeSliceOut,
  problemsUnknownTypeOut,
  reparseStaleSyncOut,
} from "@cubby/schemas/mcp";
import { assembleAllProblems, countProblems } from "@cubby/schemas/problems";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getCaller,
  READ_ONLY_CLOSED,
  registerMcpTool,
  WRITE_CLOSED,
} from "./_shared";

export function registerProblemsTools(server: McpServer) {
  registerMcpTool(server, {
    name: "list_problems",
    description:
      "List data-quality problems across products, inventory, locations, and recipes, plus household-tracker items needing attention (overdue tasks, stalled/blocked projects, past-due planned purchases, missing budgets, unclassified purchases).",
    inputSchema: {
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
    },
    outputSchema: z.union([
      problemsCountSchema,
      allProblemsSchema,
      problemsTypeSliceOut,
      problemsUnknownTypeOut,
    ]),
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const [fast, coverage, upc, tracker] = await Promise.all([
        caller.problems.getFast(),
        caller.problems.getCoverage(),
        caller.problems.getUpc(),
        caller.problems.getTracker(),
      ]);
      const all = assembleAllProblems({ fast, coverage, upc, tracker });
      if (params.countsOnly) {
        return countProblems(all);
      }
      if (typeof params.type === "string") {
        const slice = (all as Record<string, unknown>)[params.type];
        if (slice === undefined) {
          return {
            error: `Unknown problem type '${params.type}'`,
            availableTypes: Object.keys(all as Record<string, unknown>),
          };
        }
        return { type: params.type, items: slice };
      }
      return all;
    },
  });

  registerMcpTool(server, {
    name: "reparse_stale_parses",
    description:
      "Re-parse every recipe line whose stored parse has drifted from the current parser.",
    inputSchema: {},
    outputSchema: reparseStaleSyncOut,
    annotations: WRITE_CLOSED,
    handler: async (_params, extra) => {
      const caller = getCaller(extra);
      return caller.problems.reparseStaleSync();
    },
  });
}
