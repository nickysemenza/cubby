import {
  mcpToolCatalogOut,
  mcpUsageDashboardBrowserOut,
} from "@cubby/schemas/telemetry";

import { mcpContract } from "~/contracts/mcp.contract";
import {
  listMcpToolCatalog,
  MCP_SERVER_INSTRUCTIONS,
} from "~/server/mcp/server";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { listMcpUsageActivity } from "~/server/repo/mcp-usage";
import { getMcpUsageDashboard } from "~/server/services/mcp-usage.service";

export const mcpHandlers = implementOperationDomain(mcpContract, {
  listTools: async () => {
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
