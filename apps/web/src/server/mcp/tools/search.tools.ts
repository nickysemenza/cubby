import { globalSearchMcpOut } from "@cubby/schemas/mcp";
import { globalSearchInputSchema } from "@cubby/schemas/search";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCaller, READ_ONLY_OPEN, registerMcpTool } from "./_shared";

export function registerSearchTools(server: McpServer) {
  registerMcpTool(server, {
    name: "global_search",
    description:
      "Search across all entities (products, locations, inventory, recipes).",
    inputSchema: globalSearchInputSchema.shape,
    outputSchema: globalSearchMcpOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.search.global({
        query: params.query,
        limit: (params.limit as number | undefined) ?? 10,
      });
      return { results: result };
    },
  });
}
