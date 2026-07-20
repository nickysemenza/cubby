/**
 * Project-tracker MCP tools — projects / tasks / purchases, DB-backed.
 * Successor of the retired Notion-proxy tools (notion.tools.ts): same
 * list_projects/list_tasks/list_purchases surface plus full CRUD. A project's
 * former Notion page body now lives on `notes` (markdown), returned by
 * get_project.
 */

import {
  actionableTasksOut,
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
  registerEntityCrudToolset,
  registerRouterTool,
  slimProject,
  slimPurchase,
  slimTask,
} from "./_shared";

export function registerProjectTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "project",
    entityPlural: "projects",
    idLabel: "Project",
    createInput: projectCreateInput.shape,
    updateShape: projectUpdateData.shape,
    filterFields: projectFilterFields,
    mcpListOut: projectMcpListOut,
    out: projectOut,
    slim: slimProject,
    sort: { orderBy: "startDate", direction: "desc" },
    descriptions: {
      list: "List household projects with status, kind, dates, cost estimate, spend/progress rollups, and dependency ids. Filter by status/kind/location/search.",
      get: "Get a project by ID, including markdown notes (the former Notion page body), rollups, and blocked-by/blocking project ids.",
      create:
        "Create a household project (status planning|not_started|in_progress|done, kind furniture|workshop|household|renovation|garden).",
      update:
        "Update a project's fields; `blockedByIds` replaces the full set of projects blocking this one.",
      delete:
        "Soft-delete projects by IDs. Fails while live tasks or purchases still reference a project.",
    },
    create: (caller, params) => caller.project.create(params),
  });

  registerEntityCrudToolset(server, {
    entity: "task",
    entityPlural: "tasks",
    idLabel: "Task",
    createInput: taskCreateInput.shape,
    updateShape: taskUpdateData.shape,
    filterFields: taskFilterFields,
    mcpListOut: taskMcpListOut,
    out: taskOut,
    slim: slimTask,
    sort: { orderBy: "createdAt", direction: "desc" },
    descriptions: {
      list: "List project tasks with status, due dates, category, project name, parent task, and subtask counts. Filter by status/projectId/category/search/topLevelOnly/parentTaskId. Pass topLevelOnly=true to exclude checklist subtasks.",
      get: "Get a task by ID, including blocked-by/blocking task ids, parent task (if a subtask), and subtask counts.",
      create:
        "Create a task (status not_started|later|in_progress|blocked|done), optionally attached to a project. Set parentTaskId to create it as a checklist subtask of another task — one level only (a subtask can't itself have subtasks), and projectId is inherited from the parent when omitted. A subtask's own status is independent — the parent never auto-completes.",
      update:
        "Update a task's fields; `blockedByIds` replaces the full set of tasks blocking this one. `parentTaskId` can be set/changed/cleared, subject to the one-level rule (a task with subtasks can't become a subtask, and a subtask can't itself be a parent).",
      delete:
        "Soft-delete tasks by IDs (dependency edges are cleaned up). Deleting a task cascades to its live subtasks.",
    },
    create: (caller, params) => caller.task.create(params),
  });

  registerRouterTool(server, {
    name: "list_actionable_tasks",
    description:
      "Unblocked tasks you can act on now — live, not done, and blocked by nothing — plus blocked tasks with transitive why-chains explaining what's in the way (a manual blocked flag, a blocking task, or a blocking project, nearest blocker first).",
    outputSchema: actionableTasksOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller) => caller.task.listActionable(),
  });

  registerEntityCrudToolset(server, {
    entity: "purchase",
    entityPlural: "purchases",
    idLabel: "Purchase",
    createInput: purchaseCreateInput.shape,
    updateShape: purchaseUpdateData.shape,
    filterFields: purchaseFilterFields,
    mcpListOut: purchaseMcpListOut,
    out: purchaseOut,
    slim: slimPurchase,
    sort: { orderBy: "date", direction: "desc" },
    descriptions: {
      list: "List purchases (project spend ledger) with cost, date, category/subcategory, purchaser, and project name. Filter by category/subcategory/purchaser/projectId/future/search.",
      get: "Get a purchase by ID.",
      create:
        "Log a purchase (category materials|tools|services; set future=true for planned spend), optionally attached to a project.",
      update: "Update a purchase's fields.",
      delete: "Soft-delete purchases by IDs.",
    },
    create: (caller, params) => caller.purchase.create(params),
  });
}
