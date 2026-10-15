import {
  mcpToolCatalogOut,
  mcpUsageDashboardBrowserOut,
} from "@cubby/schemas/telemetry";

import { mcpContract } from "~/contracts/mcp.contract";
import { listMcpUsageActivity } from "~/server/mcp/mcp-usage";
import { getMcpUsageDashboard } from "~/server/mcp/mcp-usage.service";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const mcpHandlers = implementOperationDomain(mcpContract, {
  listTools: async () => {
    const { listMcpToolCatalog, MCP_SERVER_INSTRUCTIONS } =
      await import("~/server/mcp/server");
    const catalog = await listMcpToolCatalog();
    return mcpToolCatalogOut.parse({
      tools: catalog.tools,
      instructions: MCP_SERVER_INSTRUCTIONS,
    });
  },
  usageDashboard: async (context, input) =>
    mcpUsageDashboardBrowserOut.parse(
      await getMcpUsageDashboard(context.db, input.window),
    ),
  usageActivity: (context, input) => listMcpUsageActivity(context.db, input),
});
