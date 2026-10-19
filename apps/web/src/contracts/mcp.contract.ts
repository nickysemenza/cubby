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

const playbookOut = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  files: z.array(z.string()),
});

export const playbookContract = defineContract("playbook", {
  list: query({
    input: z.undefined(),
    output: z.object({ playbooks: z.array(playbookOut) }),
  }),
  get: query({
    input: z.strictObject({ name: z.string().min(1) }),
    output: playbookOut.extend({ content: z.string() }),
  }),
  read: query({
    input: z.strictObject({
      path: z.string().min(1),
      heading: z.string().min(1).optional(),
    }),
    output: z.object({
      path: z.string(),
      heading: z.string().nullable(),
      content: z.string().nullable(),
      outline: z.array(z.string()).nullable(),
    }),
  }),
});
