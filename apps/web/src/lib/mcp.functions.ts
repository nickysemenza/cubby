import {
  mcpToolCatalogOut,
  mcpUsageActivityInput,
  mcpUsageActivityOut,
  mcpUsageDashboardBrowserOut,
  mcpUsageDashboardInput,
} from "@cubby/schemas/telemetry";
import { z } from "zod";
import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const mcp = defineOperationDomain("mcp", {
  listTools: query({
    input: z.null(),
    output: mcpToolCatalogOut,
    tags: [["mcp"], ["mcp", "listTools"]],
  }),
  usageDashboard: query({
    input: mcpUsageDashboardInput,
    output: mcpUsageDashboardBrowserOut,
    tags: [["mcp"], ["mcp", "usageDashboard"]],
  }),
  usageActivity: query({
    input: mcpUsageActivityInput,
    output: mcpUsageActivityOut,
    tags: [["mcp"], ["mcp", "usageActivity"]],
  }),
});
