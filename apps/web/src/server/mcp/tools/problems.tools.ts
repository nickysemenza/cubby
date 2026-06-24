import { countProblems } from "@cubby/schemas/problems";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCaller, json, withErrorHandling } from "./_shared";

export function registerProblemsTools(server: McpServer) {
  server.tool(
    "list_problems",
    "List data-quality problems across products, inventory, locations, and recipes (e.g. duplicates, invalid UPCs, orphaned products, stale prices, stale ingredient parses where re-parsing the original line would now yield a different name). Use countsOnly for cheap triage, or type to fetch a single category.",
    {
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
          "Return only this problem category (e.g. 'orphanedProducts', 'productsWithNoImages', 'staleIngredientParses'). Ignored when countsOnly is true.",
        ),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const all = await caller.problems.getAllProblems();
      if (params.countsOnly) {
        return json(countProblems(all));
      }
      if (typeof params.type === "string") {
        const slice = (all as Record<string, unknown>)[params.type];
        if (slice === undefined) {
          return json({
            error: `Unknown problem type '${params.type}'`,
            availableTypes: Object.keys(all as Record<string, unknown>),
          });
        }
        return json({ [params.type]: slice });
      }
      return json(all);
    }),
  );
}
