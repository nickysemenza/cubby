import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCaller, json, withErrorHandling } from "./_shared";

export function registerSearchTools(server: McpServer) {
  server.tool(
    "global_search",
    "Search across all entities (products, locations, inventory, recipes).",
    {
      query: z.string().describe("Search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default 10, max 50)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.search.global({
        query: params.query,
        limit: params.limit ?? 10,
      });
      return json(result);
    }),
  );
}
