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
    input: z.null(),
    output: mcpToolCatalogOut,
  }),
  usageDashboard: query({
    input: mcpUsageDashboardInput,
    output: mcpUsageDashboardBrowserOut,
  }),
  usageActivity: query({
    input: mcpUsageActivityInput,
    output: mcpUsageActivityOut,
  }),
});
