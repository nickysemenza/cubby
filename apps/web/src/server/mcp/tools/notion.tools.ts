import { notionListEnvelope } from "@cubby/schemas/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  notionProjectContentOut,
  notionProjectSchema,
  notionPurchaseSchema,
  notionTaskSchema,
} from "~/server/clients/notion";
import {
  getCaller,
  matchesArrayFilter,
  matchesFilter,
  notionUnavailable,
  READ_ONLY_OPEN,
  registerMcpTool,
} from "./_shared";

const notionLimit = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe("Max results to return (default 50, max 200)");

const notionProjectsOut = notionListEnvelope(notionProjectSchema);
const notionTasksOut = notionListEnvelope(notionTaskSchema);
const notionPurchasesOut = notionListEnvelope(notionPurchaseSchema);

export function registerNotionTools(server: McpServer) {
  registerMcpTool(server, {
    name: "list_projects",
    description:
      "List Notion projects with optional filters. Returns project name, status, kind, location, cost estimate, dates, and Notion URL.",
    inputSchema: {
      status: z.string().optional().describe("Filter by status (substring)"),
      kind: z.string().optional().describe("Filter by kind (substring)"),
      location: z
        .string()
        .optional()
        .describe("Filter by location (substring match on any location tag)"),
      name: z
        .string()
        .optional()
        .describe("Filter by project name (substring)"),
      limit: notionLimit,
    },
    outputSchema: notionProjectsOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const items = dashboard.projects
        .filter(
          (p: Record<string, unknown>) =>
            matchesFilter(p.status as string | null, params.status) &&
            matchesFilter(p.kind as string | null, params.kind) &&
            matchesArrayFilter(p.location as string[], params.location) &&
            matchesFilter(p.name as string | null, params.name),
        )
        .slice(0, (params.limit as number | undefined) ?? 50);

      return { count: items.length, items };
    },
  });

  registerMcpTool(server, {
    name: "list_tasks",
    description:
      "List Notion tasks with optional filters. Returns task name, status, due date, category, project name, and Notion URL.",
    inputSchema: {
      status: z.string().optional().describe("Filter by status (substring)"),
      projectName: z
        .string()
        .optional()
        .describe("Filter by project name (substring)"),
      category: z
        .string()
        .optional()
        .describe("Filter by category (substring)"),
      name: z.string().optional().describe("Filter by task name (substring)"),
      limit: notionLimit,
    },
    outputSchema: notionTasksOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const items = dashboard.tasks
        .filter(
          (t: Record<string, unknown>) =>
            matchesFilter(t.status as string | null, params.status) &&
            matchesFilter(t.projectName as string | null, params.projectName) &&
            matchesFilter(t.category as string | null, params.category) &&
            matchesFilter(t.name as string | null, params.name),
        )
        .slice(0, (params.limit as number | undefined) ?? 50);

      return { count: items.length, items };
    },
  });

  registerMcpTool(server, {
    name: "list_purchases",
    description:
      "List Notion purchases with optional filters. Returns purchase name, cost, date, category, purchaser, project name, and Notion URL.",
    inputSchema: {
      category: z
        .string()
        .optional()
        .describe("Filter by category (substring)"),
      projectName: z
        .string()
        .optional()
        .describe("Filter by project name (substring)"),
      purchaser: z
        .string()
        .optional()
        .describe("Filter by purchaser (substring)"),
      name: z
        .string()
        .optional()
        .describe("Filter by purchase name (substring)"),
      limit: notionLimit,
    },
    outputSchema: notionPurchasesOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const items = dashboard.purchases
        .filter(
          (p: Record<string, unknown>) =>
            matchesFilter(p.category as string | null, params.category) &&
            matchesFilter(p.projectName as string | null, params.projectName) &&
            matchesFilter(p.purchaser as string | null, params.purchaser) &&
            matchesFilter(p.name as string | null, params.name),
        )
        .slice(0, (params.limit as number | undefined) ?? 50);

      return { count: items.length, items };
    },
  });

  registerMcpTool(server, {
    name: "get_project_content",
    description:
      "Fetch the page content of a Notion project by its page ID. Returns structured blocks.",
    inputSchema: {
      pageId: z
        .string()
        .describe("Notion page ID (from list_projects results)"),
    },
    outputSchema: notionProjectContentOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const content = await caller.notion.projectContent({
        pageId: params.pageId as string,
      });
      if (content === null) return notionUnavailable();
      return content;
    },
  });
}
