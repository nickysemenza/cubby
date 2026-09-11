import { mcpContract } from "~/contracts/mcp.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const mcp = defineOperationDomain(mcpContract, {
  listTools: { tags: [["mcp", "listTools"]] },
  usageDashboard: { tags: [["mcp", "usageDashboard"]] },
  usageActivity: { tags: [["mcp", "usageActivity"]] },
});
