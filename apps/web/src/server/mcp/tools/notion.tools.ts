import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getCaller,
  json,
  matchesArrayFilter,
  matchesFilter,
  notionUnavailable,
  withErrorHandling,
} from "./_shared";

const notionLimit = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe("Max results to return (default 50, max 200)");

export function registerNotionTools(server: McpServer) {
  server.tool(
    "list_projects",
    "List Notion projects with optional filters. Returns project name, status, kind, location, cost estimate, dates, and Notion URL.",
    {
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
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const filtered = dashboard.projects
        .filter(
          (p: Record<string, unknown>) =>
            matchesFilter(p.status as string | null, params.status) &&
            matchesFilter(p.kind as string | null, params.kind) &&
            matchesArrayFilter(p.location as string[], params.location) &&
            matchesFilter(p.name as string | null, params.name),
        )
        .slice(0, params.limit ?? 50);

      return json({ count: filtered.length, projects: filtered });
    }),
  );

  server.tool(
    "list_tasks",
    "List Notion tasks with optional filters. Returns task name, status, due date, category, project name, and Notion URL.",
    {
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
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const filtered = dashboard.tasks
        .filter(
          (t: Record<string, unknown>) =>
            matchesFilter(t.status as string | null, params.status) &&
            matchesFilter(t.projectName as string | null, params.projectName) &&
            matchesFilter(t.category as string | null, params.category) &&
            matchesFilter(t.name as string | null, params.name),
        )
        .slice(0, params.limit ?? 50);

      return json({ count: filtered.length, tasks: filtered });
    }),
  );

  server.tool(
    "list_purchases",
    "List Notion purchases with optional filters. Returns purchase name, cost, date, category, purchaser, project name, and Notion URL.",
    {
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
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const filtered = dashboard.purchases
        .filter(
          (p: Record<string, unknown>) =>
            matchesFilter(p.category as string | null, params.category) &&
            matchesFilter(p.projectName as string | null, params.projectName) &&
            matchesFilter(p.purchaser as string | null, params.purchaser) &&
            matchesFilter(p.name as string | null, params.name),
        )
        .slice(0, params.limit ?? 50);

      return json({ count: filtered.length, purchases: filtered });
    }),
  );

  server.tool(
    "get_project_content",
    "Fetch the page content of a Notion project by its page ID. Returns structured blocks (paragraphs, headings, lists, images, etc.).",
    {
      pageId: z
        .string()
        .describe("Notion page ID (from list_projects results)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const content = await caller.notion.projectContent({
        pageId: params.pageId,
      });
      if (content === null) return notionUnavailable();
      return json(content);
    }),
  );
}
