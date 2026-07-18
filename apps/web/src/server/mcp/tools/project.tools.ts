/**
 * Project-tracker MCP tools — projects / tasks / purchases, DB-backed.
 * Successor of the retired Notion-proxy tools (notion.tools.ts): same
 * list_projects/list_tasks/list_purchases surface plus full CRUD. A project's
 * former Notion page body now lives on `notes` (markdown), returned by
 * get_project.
 */

import {
  projectCreateInput,
  projectFilterFields,
  projectMcpListOut,
  projectOut,
  projectUpdateData,
  purchaseCreateInput,
  purchaseFilterFields,
  purchaseMcpListOut,
  purchaseOut,
  purchaseUpdateData,
  taskCreateInput,
  taskFilterFields,
  taskMcpListOut,
  taskOut,
  taskUpdateData,
} from "@cubby/schemas/project";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  READ_ONLY_CLOSED,
  registerEntityCreateTool,
  registerEntityDeleteTool,
  registerEntityGetTool,
  registerEntityListTool,
  registerEntityUpdateTool,
  slimProject,
  slimPurchase,
  slimTask,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
  withIdInput,
} from "./_shared";

export function registerProjectTools(server: McpServer) {
  // -- Projects --
  registerEntityListTool(server, {
    name: "list_projects",
    description:
      "List household projects with status, kind, dates, cost estimate, spend/progress rollups, and dependency ids. Filter by status/kind/location/search.",
    router: "project",
    filterFields: projectFilterFields,
    outputSchema: projectMcpListOut,
    slim: slimProject,
    sort: { orderBy: "startDate", direction: "desc" },
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityGetTool(server, {
    name: "get_project",
    description:
      "Get a project by ID, including markdown notes (the former Notion page body), rollups, and blocked-by/blocking project ids.",
    router: "project",
    idLabel: "Project",
    outputSchema: projectOut,
    slim: slimProject,
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityCreateTool(server, {
    name: "create_project",
    description:
      "Create a household project (status planning|not_started|in_progress|done, kind furniture|workshop|household|renovation|garden).",
    inputSchema: projectCreateInput.shape,
    outputSchema: projectOut,
    slim: slimProject,
    annotations: WRITE_CLOSED,
    create: (caller, params) => caller.project.create(params),
  });

  registerEntityUpdateTool(server, {
    name: "update_project",
    description:
      "Update a project's fields; `blockedByIds` replaces the full set of projects blocking this one.",
    inputSchema: withIdInput("Project", projectUpdateData.shape),
    outputSchema: projectOut,
    slim: slimProject,
    router: "project",
    annotations: WRITE_CLOSED,
  });

  registerEntityDeleteTool(server, {
    name: "delete_projects",
    description:
      "Soft-delete projects by IDs. Fails while live tasks or purchases still reference a project.",
    router: "project",
    entityLabel: "project",
    annotations: WRITE_DESTRUCTIVE_CLOSED,
  });

  // -- Tasks --
  registerEntityListTool(server, {
    name: "list_tasks",
    description:
      "List project tasks with status, due dates, category, project name, and dependency ids. Filter by status/projectId/category/search.",
    router: "task",
    filterFields: taskFilterFields,
    outputSchema: taskMcpListOut,
    slim: slimTask,
    sort: { orderBy: "createdAt", direction: "desc" },
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityGetTool(server, {
    name: "get_task",
    description: "Get a task by ID, including blocked-by/blocking task ids.",
    router: "task",
    idLabel: "Task",
    outputSchema: taskOut,
    slim: slimTask,
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityCreateTool(server, {
    name: "create_task",
    description:
      "Create a task (status not_started|later|in_progress|blocked|done), optionally attached to a project.",
    inputSchema: taskCreateInput.shape,
    outputSchema: taskOut,
    slim: slimTask,
    annotations: WRITE_CLOSED,
    create: (caller, params) => caller.task.create(params),
  });

  registerEntityUpdateTool(server, {
    name: "update_task",
    description:
      "Update a task's fields; `blockedByIds` replaces the full set of tasks blocking this one.",
    inputSchema: withIdInput("Task", taskUpdateData.shape),
    outputSchema: taskOut,
    slim: slimTask,
    router: "task",
    annotations: WRITE_CLOSED,
  });

  registerEntityDeleteTool(server, {
    name: "delete_tasks",
    description: "Soft-delete tasks by IDs (dependency edges are cleaned up).",
    router: "task",
    entityLabel: "task",
    annotations: WRITE_DESTRUCTIVE_CLOSED,
  });

  // -- Purchases --
  registerEntityListTool(server, {
    name: "list_purchases",
    description:
      "List purchases (project spend ledger) with cost, date, category/subcategory, purchaser, and project name. Filter by category/subcategory/purchaser/projectId/future/search.",
    router: "purchase",
    filterFields: purchaseFilterFields,
    outputSchema: purchaseMcpListOut,
    slim: slimPurchase,
    sort: { orderBy: "date", direction: "desc" },
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityGetTool(server, {
    name: "get_purchase",
    description: "Get a purchase by ID.",
    router: "purchase",
    idLabel: "Purchase",
    outputSchema: purchaseOut,
    slim: slimPurchase,
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityCreateTool(server, {
    name: "create_purchase",
    description:
      "Log a purchase (category materials|tools|services; set future=true for planned spend), optionally attached to a project.",
    inputSchema: purchaseCreateInput.shape,
    outputSchema: purchaseOut,
    slim: slimPurchase,
    annotations: WRITE_CLOSED,
    create: (caller, params) => caller.purchase.create(params),
  });

  registerEntityUpdateTool(server, {
    name: "update_purchase",
    description: "Update a purchase's fields.",
    inputSchema: withIdInput("Purchase", purchaseUpdateData.shape),
    outputSchema: purchaseOut,
    slim: slimPurchase,
    router: "purchase",
    annotations: WRITE_CLOSED,
  });

  registerEntityDeleteTool(server, {
    name: "delete_purchases",
    description: "Soft-delete purchases by IDs.",
    router: "purchase",
    entityLabel: "purchase",
    annotations: WRITE_DESTRUCTIVE_CLOSED,
  });
}
