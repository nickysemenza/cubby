import {
  mcpToolCatalogOut,
  mcpUsageActivityInput,
  mcpUsageActivityOut,
  mcpUsageDashboardBrowserOut,
  mcpUsageDashboardInput,
} from "@cubby/schemas/telemetry";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

export const mcpContract = defineContract(
  "mcp",
  {
    listTools: query({
      exposure: "view",
      note: "The Settings tool catalog; agents list tools over MCP itself",
      input: z.null(),
      output: mcpToolCatalogOut,
    }),
    usageDashboard: query({
      note: "MCP usage telemetry",
      description:
        "Read aggregate MCP tool usage for the requested time window and filters. This is telemetry and does not include household record contents.",
      input: mcpUsageDashboardInput,
      output: mcpUsageDashboardBrowserOut,
    }),
    usageActivity: query({
      note: "MCP usage telemetry",
      description:
        "Read recent MCP tool-call activity for the requested filters. Use usage_dashboard for aggregate counts and trends.",
      input: mcpUsageActivityInput,
      output: mcpUsageActivityOut,
    }),
  },
  { exposure: "capability", mcpToolGroup: "maintenance" },
);

const playbookOut = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  files: z.array(z.string()),
});

export const playbookContract = defineContract(
  "playbook",
  {
    list: query({
      description:
        "Every playbook's name, when to use it (description), entry path, and the files it bundles.",
      input: z.undefined(),
      output: z.object({ playbooks: z.array(playbookOut) }),
    }),
    get: query({
      description:
        "One playbook's SKILL.md by name. Its relative links are repository paths: read them with playbook.read when a step needs them.",
      input: z.strictObject({ name: z.string().min(1) }),
      output: playbookOut.extend({ content: z.string() }),
    }),
    read: query({
      description:
        "A file a playbook links to, by repository path. Pass a link's #anchor (or the heading text) as heading to read just that section; a large file read without a heading returns its outline instead of its text.",
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
  },
  { exposure: "capability" },
);
