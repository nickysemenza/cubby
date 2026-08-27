import { mcp } from "~/lib/mcp.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getMcpUsageDashboardWorkflow,
  listMcpCatalogWorkflow,
  listMcpUsageActivityWorkflow,
} from "~/server/workflows/mcp-browser.server";

export const mcpHandlers = implementOperationDomain(mcp, {
  listTools: {
    readPolicy: "strong",
    run: () => listMcpCatalogWorkflow(),
  },
  usageDashboard: {
    readPolicy: "strong",
    run: (context, input) => getMcpUsageDashboardWorkflow(context.db, input),
  },
  usageActivity: {
    readPolicy: "strong",
    run: (context, input) => listMcpUsageActivityWorkflow(context.db, input),
  },
});
