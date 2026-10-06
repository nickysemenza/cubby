import {
  mcpToolCatalogOut,
  mcpUsageActivityInput,
  mcpUsageActivityOut,
  mcpUsageDashboardBrowserOut,
  mcpUsageDashboardInput,
} from "@cubby/schemas/telemetry";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

export const mcpContract = defineContract("mcp", {
  listTools: query({
    mcp: {
      omit: "client_view",
      note: "The Settings tool catalog; agents list tools over MCP itself",
    },
    input: z.null(),
    output: mcpToolCatalogOut,
  }),
  usageDashboard: query({
    mcp: { omit: "operator_maintenance", note: "MCP usage telemetry" },
    input: mcpUsageDashboardInput,
    output: mcpUsageDashboardBrowserOut,
  }),
  usageActivity: query({
    mcp: { omit: "operator_maintenance", note: "MCP usage telemetry" },
    input: mcpUsageActivityInput,
    output: mcpUsageActivityOut,
  }),
});
