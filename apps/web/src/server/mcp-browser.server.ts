import { mcpContract } from "~/contracts/mcp.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getMcpUsageDashboardWorkflow,
  listMcpCatalogWorkflow,
  listMcpUsageActivityWorkflow,
} from "~/server/workflows/mcp-browser.server";

export const mcpHandlers = implementOperationDomain(mcpContract, {
  listTools: {
    run: () => listMcpCatalogWorkflow(),
  },
  usageDashboard: {
    run: (context, input) => getMcpUsageDashboardWorkflow(context.db, input),
  },
  usageActivity: {
    run: (context, input) => listMcpUsageActivityWorkflow(context.db, input),
  },
});
