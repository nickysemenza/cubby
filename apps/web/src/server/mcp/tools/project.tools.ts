/**
 * Project-tracker MCP tools — projects / tasks / purchases, DB-backed.
 * Successor of the retired Notion-proxy tools (notion.tools.ts): same
 * list_projects/list_tasks/list_purchases surface plus full CRUD. A project's
 * former Notion page body now lives on `notes` (markdown), returned by
 * get_project.
 */

import { projectId } from "@cubby/schemas/identifiers";
import {
  actionableTasksOut,
  projectCreateInput,
  projectDashboardFiltersSchema,
  projectDashboardSummaryOut,
  projectFilterFields,
  projectMcpListOut,
  projectOut,
  projectPortfolioAnalyticsInput,
  projectPortfolioAnalyticsOut,
  projectUpdateData,
  purchaseAnalyticsOut,
  purchaseBulkCostTypeInput,
  purchaseBulkMoveInput,
  purchaseBulkTradeInput,
  purchaseCreateInput,
  purchaseFilterFields,
  purchaseMcpListOut,
  purchaseOut,
  purchaseUpdateData,
  taskBulkDueDateInput,
  taskBulkMoveInput,
  taskBulkStatusInput,
  taskCreateInput,
  taskFilterFields,
  taskMcpListOut,
  taskOut,
  taskSummaryOut,
  taskUpdateData,
} from "@cubby/schemas/project";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sumBy } from "es-toolkit";
import { z } from "zod";
import {
  READ_ONLY_CLOSED,
  registerEntityCrudToolset,
  registerRouterTool,
  slimProject,
  slimPurchase,
  slimTask,
  WRITE_CLOSED,
} from "./_shared";

// ---------------------------------------------------------------------------
// Synthesis-read / bulk-write projections
//
// These trim the router outputs the same way the slim* projections trim list
// rows: the handler passes the router payload straight through and the output
// schema's parse drops the keys below (zod objects strip unknown keys), so a
// new field on the underlying schema flows through without an MCP-side edit.
// ---------------------------------------------------------------------------

/** Project row for `get_house_status` — identity, dates, budget and the own +
 * subtree rollup, minus the markdown notes, icon, dependency/child id arrays
 * and timestamps that `get_project` already returns in full. */
const houseStatusProject = projectOut.omit({
  notes: true,
  icon: true,
  childProjectIds: true,
  blockedByIds: true,
  blockingIds: true,
  createdAt: true,
  updatedAt: true,
});

/** Upcoming-task row for `get_house_status` — enough to name and schedule the
 * task; `get_task` / `list_actionable_tasks` own the blocking graph. */
const houseStatusTask = taskOut.pick({
  id: true,
  name: true,
  status: true,
  projectId: true,
  projectName: true,
  dueDate: true,
  dueEndDate: true,
  trade: true,
});

/** `project.dashboardSummary` minus `filterOptions` (UI select options only). */
const houseStatusOut = projectDashboardSummaryOut
  .omit({ filterOptions: true, projects: true, nextTasks: true })
  .extend({
    projects: z.array(houseStatusProject),
    nextTasks: z.array(houseStatusTask),
  });

/** One project's planned-vs-actual envelope, derived from
 * `portfolioAnalytics.costVsEstimate` (subtree lifetime totals). */
const projectBudgetRow = z.object({
  projectId,
  projectName: z.string(),
  estimate: z
    .number()
    .nullable()
    .describe("Budget envelope in dollars (subtree sum); null when unbudgeted"),
  actual: z.number().describe("Money already spent (subtree)"),
  committed: z.number().describe("Planned, not-yet-spent purchases (subtree)"),
  projected: z.number().describe("actual + committed"),
  remaining: z
    .number()
    .nullable()
    .describe("estimate − projected; null when there's no estimate"),
  percentUsed: z
    .number()
    .nullable()
    .describe("Whole-percent projected/estimate; null without an estimate"),
  overBudget: z.boolean().describe("projected exceeds estimate"),
});

const projectBudgetOut = z.object({
  projects: z
    .array(projectBudgetRow)
    .describe("Worst overrun first; unbudgeted projects last"),
  totals: z.object({
    estimate: z.number(),
    actual: z.number(),
    committed: z.number(),
    projected: z.number(),
    overBudgetCount: z.number().int(),
    missingEstimateCount: z.number().int(),
  }),
  plannedVsActualByMonth: projectPortfolioAnalyticsOut.shape.plannedVsActual,
});

/** Bulk task writes return the updated rows plus the background batches they
 * enqueued (embedding refresh); MCP clients only need the rows and a count. */
const taskBulkMcpOut = z.object({
  updated: z.number().int(),
  items: z.array(taskOut),
});

/** Same shape for the purchase bulk writes (bulkMove/bulkSetTrade/bulkSetCostType). */
const purchaseBulkMcpOut = z.object({
  updated: z.number().int(),
  items: z.array(purchaseOut),
});

/** Drop `sideEffects` and add the count — entity-agnostic, shared by the task
 * and purchase bulk tools. */
async function bulkEntityWrite<T>(run: Promise<{ items: T[] }>) {
  const { items } = await run;
  return { updated: items.length, items };
}

export function registerProjectTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "project",
    createInput: projectCreateInput.shape,
    updateShape: projectUpdateData.shape,
    filterFields: projectFilterFields,
    mcpListOut: projectMcpListOut,
    out: projectOut,
    slim: slimProject,
    sort: { orderBy: "startDate", direction: "desc" },
    descriptions: {
      list: "List household projects with status, kind, dates, cost estimate, spend/progress rollups (own + subtree), parent/child project links, and dependency ids. Filter by status/kind/location/search/topLevelOnly/parentProjectId/includeSubProjects. Pass topLevelOnly=true to exclude sub-projects; pass includeSubProjects=true with parentProjectId to match the whole live subtree under that parent, not just direct children.",
      get: "Get a project by ID, including markdown notes (the former Notion page body), own + subtree rollups, parent/child project links, and blocked-by/blocking project ids.",
      create:
        "Create a household project (status planning|not_started|in_progress|done, kind furniture|workshop|household|renovation|garden). Set parentProjectId to create it as a sub-project (arbitrary depth) — a phase/trade with its own costEstimate budget envelope; tasks/purchases still attribute to it via their own projectId.",
      update:
        "Update a project's fields; `blockedByIds` replaces the full set of projects blocking this one. `parentProjectId` can be set/changed/cleared, subject to a cycle guard (a project can't become its own descendant).",
      delete:
        "Soft-delete projects by IDs. Fails while live tasks, purchases, or sub-projects still reference a project.",
    },
    create: (caller, params) => caller.project.create(params),
  });

  registerRouterTool(server, {
    name: "get_house_status",
    description:
      'What needs attention around the house, in one call. Returns portfolio counts (active projects, open tasks, actual vs committed spend), the active projects with own + subtree rollups, a per-project task-status breakdown, the next upcoming tasks, and `attention[]` — overdue tasks, stalled projects, past-due planned purchases, missing budgets, unclassified purchases and blocked work, each with a severity, the entity it points at, and a link. Start here for "how are the projects going" / "what should I deal with", then drill in with get_project / list_tasks. Optional filters scope it to a status set, project kinds, locations, or a search term.',
    inputSchema: projectDashboardFiltersSchema.shape,
    outputSchema: houseStatusOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.project.dashboardSummary(params),
  });

  registerRouterTool(server, {
    name: "get_project_budget",
    description:
      "Which projects are over budget: per project, the subtree budget estimate vs actual + committed spend, with remaining, percentUsed and an overBudget flag, sorted worst-overrun first (unbudgeted projects last). Also returns portfolio totals and planned-vs-actual spend by month. Same optional scope filters as get_house_status, plus dateFrom/dateTo (which bound the monthly series only — the per-project figures are lifetime).",
    inputSchema: projectPortfolioAnalyticsInput.shape,
    outputSchema: projectBudgetOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) => {
      const analytics = await caller.project.portfolioAnalytics(params);
      const projects = analytics.costVsEstimate
        .map((row) => {
          const projected = row.actual + row.committed;
          const estimate = row.estimate;
          return {
            ...row,
            projected,
            remaining: estimate === null ? null : estimate - projected,
            percentUsed:
              estimate === null || estimate <= 0
                ? null
                : Math.round((projected / estimate) * 100),
            overBudget: estimate !== null && projected > estimate,
          };
        })
        .sort((a, b) => {
          // Biggest overrun first; unbudgeted rows sink to the bottom, ordered
          // by projected spend (they're the missing-budget attention items).
          if (a.remaining === null || b.remaining === null) {
            if (a.remaining === b.remaining) return b.projected - a.projected;
            return a.remaining === null ? 1 : -1;
          }
          return a.remaining - b.remaining || b.projected - a.projected;
        });

      return {
        projects,
        totals: {
          estimate: sumBy(projects, (p) => p.estimate ?? 0),
          actual: sumBy(projects, (p) => p.actual),
          committed: sumBy(projects, (p) => p.committed),
          projected: sumBy(projects, (p) => p.projected),
          overBudgetCount: projects.filter((p) => p.overBudget).length,
          missingEstimateCount: projects.filter((p) => p.estimate === null)
            .length,
        },
        plannedVsActualByMonth: analytics.plannedVsActual,
      };
    },
  });

  registerEntityCrudToolset(server, {
    entity: "task",
    createInput: taskCreateInput.shape,
    updateShape: taskUpdateData.shape,
    filterFields: taskFilterFields,
    mcpListOut: taskMcpListOut,
    out: taskOut,
    slim: slimTask,
    sort: { orderBy: "createdAt", direction: "desc" },
    descriptions: {
      list: 'List project tasks with status, due dates, trade, project name, parent task, and subtask counts. Filter by status/projectId/trade/search/topLevelOnly/parentTaskId/includeSubProjects/projectPresenceFilter. Pass topLevelOnly=true to exclude checklist subtasks; pass includeSubProjects=true with projectId to also match tasks in that project\'s live descendant sub-projects. projectPresenceFilter="none" is the Inbox (tasks with no project) and "has" is filed work; combined with projectId it WIDENS rather than narrows — {projectId, projectPresenceFilter:"none"} means that project OR unassigned.',
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

  registerRouterTool(server, {
    name: "get_task_summary",
    description:
      "Task counts across the whole tracker in one cheap call: totalOpen, next (unblocked and actionable now), later, inbox (tasks with no project), overdue, dueThisWeek (rolling 7 days), blocked. Use it to size the backlog before paging list_tasks.",
    outputSchema: taskSummaryOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller) => caller.task.summary(),
  });

  registerRouterTool(server, {
    name: "bulk_set_task_status",
    description:
      'Set the same status on many tasks at once (not_started|later|in_progress|blocked|done) — the triage path for "mark these done" / "park these". Returns the updated rows and a count.',
    inputSchema: taskBulkStatusInput.shape,
    outputSchema: taskBulkMcpOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) =>
      bulkEntityWrite(caller.task.bulkSetStatus(params)),
  });

  registerRouterTool(server, {
    name: "bulk_move_tasks",
    description:
      "Move many tasks onto one project at once; pass projectId: null to move them back to the Inbox (no project). Use after list_tasks to file loose inbox work. Returns the updated rows and a count.",
    inputSchema: taskBulkMoveInput.shape,
    outputSchema: taskBulkMcpOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => bulkEntityWrite(caller.task.bulkMove(params)),
  });

  registerRouterTool(server, {
    name: "bulk_set_task_due_date",
    description:
      "Set (or clear) the same due date on many tasks. Both dueDate and dueEndDate are required — pass null to clear; a dueDate alone is a single-day task, both set is a date range. Returns the updated rows and a count.",
    inputSchema: taskBulkDueDateInput.shape,
    outputSchema: taskBulkMcpOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) =>
      bulkEntityWrite(caller.task.bulkSetDueDate(params)),
  });

  registerEntityCrudToolset(server, {
    entity: "purchase",
    createInput: purchaseCreateInput.shape,
    updateShape: purchaseUpdateData.shape,
    filterFields: purchaseFilterFields,
    mcpListOut: purchaseMcpListOut,
    out: purchaseOut,
    slim: slimPurchase,
    sort: { orderBy: "date", direction: "desc" },
    descriptions: {
      list: 'List purchases (project spend ledger) with cost, date, costType/trade, and project name. Filter by costType/trade/projectId/future/search/includeSubProjects/dateFrom/dateTo/projectPresenceFilter (dateFrom/dateTo are inclusive YYYY-MM-DD bounds on purchase date). Pass includeSubProjects=true with projectId to match the whole live subtree under that project, not just its own purchases. projectPresenceFilter="none" is the unassigned-spend worklist and "has" is attributed spend; combined with projectId it WIDENS rather than narrows — {projectId, projectPresenceFilter:"none"} means that project OR unassigned.',
      get: "Get a purchase by ID.",
      create:
        "Log a purchase (costType materials|tools|services; set future=true for planned spend), optionally attached to a project.",
      update: "Update a purchase's fields.",
      delete: "Soft-delete purchases by IDs.",
    },
    create: (caller, params) => caller.purchase.create(params),
  });

  registerRouterTool(server, {
    name: "get_purchase_analytics",
    description:
      'Spend aggregates over the purchase ledger, under the SAME filters as list_purchases (costType/trade/projectId/includeSubProjects/future/search/dateFrom/dateTo/costIsNull/projectPresenceFilter), so ledger and analytics totals always agree. Returns summary (actual/committed/credits/net + counts), byCostType, byTrade, the trade x costType matrix, monthly totals, a cumulative net curve, and byProject. Answers "what did we spend on X / where did the money go" without paging the ledger. Note: credits are real (refunds, family contributions) — net = actual + committed − credits.',
    inputSchema: purchaseFilterFields,
    outputSchema: purchaseAnalyticsOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.purchase.analytics(params),
  });

  registerRouterTool(server, {
    name: "bulk_move_purchases",
    description:
      "Move many purchases onto one project at once; pass projectId: null to move them back to the Inbox (no project). Use after list_purchases to file loose or mis-attributed spend. Returns the updated rows and a count.",
    inputSchema: purchaseBulkMoveInput.shape,
    outputSchema: purchaseBulkMcpOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => bulkEntityWrite(caller.purchase.bulkMove(params)),
  });

  registerRouterTool(server, {
    name: "bulk_set_purchase_trade",
    description:
      "Set the same trade on many purchases at once (the 19-slug trade taxonomy shared with tasks and sub-projects — electrical|plumbing|countertop|…|other). Trade is required, not nullable: pass `other` rather than clearing it. Use after list_purchases (filter trade to find unclassified spend). Returns the updated rows and a count.",
    inputSchema: purchaseBulkTradeInput.shape,
    outputSchema: purchaseBulkMcpOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) =>
      bulkEntityWrite(caller.purchase.bulkSetTrade(params)),
  });

  registerRouterTool(server, {
    name: "bulk_set_purchase_cost_type",
    description:
      "Set the same costType on many purchases at once (materials|tools|services). Required, not nullable. Use after list_purchases to reclassify a batch of ledger lines so get_purchase_analytics' byCostType split is right. Returns the updated rows and a count.",
    inputSchema: purchaseBulkCostTypeInput.shape,
    outputSchema: purchaseBulkMcpOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) =>
      bulkEntityWrite(caller.purchase.bulkSetCostType(params)),
  });
}
