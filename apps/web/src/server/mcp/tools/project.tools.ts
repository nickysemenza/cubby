/**
 * Project-tracker MCP tools — projects / tasks / expenses, DB-backed.
 * Successor of the retired Notion-proxy tools (notion.tools.ts): same
 * list_projects/list_tasks/list_expenses surface plus full CRUD. A project's
 * former Notion page body now lives on `notes` (markdown), returned by
 * get_project.
 */

import { projectId } from "@cubby/schemas/identifiers";
import {
  actionableTasksOut,
  expenseAnalyticsOut,
  expenseBulkCostTypeInput,
  expenseBulkMoveInput,
  expenseBulkTradeInput,
  expenseCreateInput,
  expenseFilterFields,
  expenseMcpListOut,
  expenseOut,
  expenseUpdateData,
  LIVE_PROJECT_STATUSES,
  projectCreateInput,
  projectDashboardFiltersSchema,
  projectDashboardSummaryOut,
  projectFilterFields,
  projectMcpListOut,
  projectOut,
  projectPortfolioAnalyticsOut,
  projectUpdateData,
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
  slimExpense,
  slimProject,
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
  googleDriveFolderUrl: true,
  notionPageUrl: true,
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
  subjectProductId: true,
  subjectProductName: true,
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
  committed: z.number().describe("Planned, not-yet-spent expenses (subtree)"),
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

/** Same shape for the expense bulk writes (bulkMove/bulkSetTrade/bulkSetCostType). */
const expenseBulkMcpOut = z.object({
  updated: z.number().int(),
  items: z.array(expenseOut),
});

/** Drop `sideEffects` and add the count — entity-agnostic, shared by the task
 * and expense bulk tools. */
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
      list: "List household projects with status, kind, dates, cost estimate, canonical Google Drive/Notion resource URLs, spend/progress rollups (own + subtree), parent/child project links, and dependency ids. Read dates from the `dates` object (derivedStart/derivedEnd, effectiveStart/effectiveEnd, startSource/endSource), NOT from the top-level startDate/endDate — those two are manual overrides and are usually null. Filter by status/kind/location/search/topLevelOnly/parentProjectId/includeSubProjects. Pass topLevelOnly=true to exclude sub-projects; pass includeSubProjects=true with parentProjectId to match the whole live subtree under that parent, not just direct children.",
      get: "Get a project by ID, including markdown notes (the former Notion page body), canonical googleDriveFolderUrl/notionPageUrl resource links, own + subtree rollups, parent/child project links, blocked-by/blocking project ids, and the `dates` object (derived vs effective window plus which source each side came from). Prefer dates.effectiveStart/dates.effectiveEnd over the raw startDate/endDate override columns.",
      create:
        "Create a household project (status planning|not_started|in_progress|done, kind furniture|workshop|household|renovation|garden). Set parentProjectId to create it as a sub-project (arbitrary depth) — a phase/trade with its own costEstimate budget envelope; tasks/expenses still attribute to it via their own projectId. startDate/endDate are OVERRIDES on a derived window, not the window itself: a project's dates are normally rolled up from its own tasks and expenses plus every live sub-project, and writing either column PINS that side and suppresses the roll-up for it. Leave both unset unless you are recording a date the work itself doesn't imply (a contracted start, a hard deadline) — a stale override does not widen to cover later activity, it just goes wrong quietly.",
      update:
        "Update a project's fields; `blockedByIds` replaces the full set of projects blocking this one. `parentProjectId` can be set/changed/cleared, subject to a cycle guard (a project can't become its own descendant). startDate/endDate are OVERRIDES on a derived window (see create): setting one pins that side and suppresses the roll-up from tasks/expenses/sub-projects; clearing it (null) hands that side back to the roll-up. Do not write today's derived value back into the column — that freezes a window which would otherwise keep tracking the work.",
      delete:
        "Soft-delete projects by IDs. Fails while live tasks, expenses, or sub-projects still reference a project.",
    },
    create: (caller, params) => caller.project.create(params),
  });

  registerRouterTool(server, {
    name: "get_house_status",
    description:
      'What needs attention around the house, in one call. Returns portfolio counts (active projects, open tasks, actual vs committed spend), the active projects with own + subtree rollups, a per-project task-status breakdown, the next upcoming tasks, and `attention[]` — overdue tasks, stalled projects, past-due planned expenses, missing budgets, unclassified expenses and blocked work, each with a severity, the entity it points at, and a link. Start here for "how are the projects going" / "what should I deal with", then drill in with get_project / list_tasks. Optional filters scope it to a status set, project kinds, locations, a search term, or a date window (dateFrom/dateTo — a project matches when its startDate/endDate override overlaps the window OR it has a task or expense of its own inside it; only projects with no override and no dated content at all are dropped, and that count comes back as hiddenByDate.projects). statusScope defaults to the live statuses (planning/not_started/in_progress) when omitted, so this payload does not balloon with completed history — pass statusScope explicitly (e.g. ["done"]) to include finished projects.',
    inputSchema: projectDashboardFiltersSchema.shape,
    outputSchema: houseStatusOut,
    annotations: READ_ONLY_CLOSED,
    // `projectDashboardFiltersSchema`'s own default is changing to "no status
    // condition" (all four statuses) — this tool mirrors the UI's Overview
    // default instead, so its payload doesn't balloon with completed-project
    // history when the caller doesn't specify a scope. Behavior-preserving
    // today: `ne(status,'done')` (the old default) is equivalent to
    // `inArray(LIVE_PROJECT_STATUSES)` given exactly 4 statuses.
    call: (caller, params) =>
      caller.project.dashboardSummary({
        statusScope: [...LIVE_PROJECT_STATUSES],
        ...params,
      }),
  });

  registerRouterTool(server, {
    name: "get_project_budget",
    description:
      "Which projects are over budget: per project, the subtree budget estimate vs actual + committed spend, with remaining, percentUsed and an overBudget flag, sorted worst-overrun first (unbudgeted projects last). Also returns portfolio totals and planned-vs-actual spend by month. Same optional scope filters as get_house_status (status set, project kinds, locations, search, dateFrom/dateTo), but statusScope defaults to no condition (all four statuses, including done) — a budget tool silently omitting completed spend would be a bug, not a feature. dateFrom/dateTo scope the whole query, not just the monthly series: while a window is set, a project is kept when its startDate/endDate override overlaps it OR it owns a task or expense inside it, and only projects with no dates from any source drop out of the per-project figures.",
    inputSchema: projectDashboardFiltersSchema.shape,
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
      list: 'List project tasks with status, due dates, trade, project name, optional subject product ("what this task is for"), parent task, and subtask counts. Filter by status/projectId/subjectProductId/trade/search/topLevelOnly/parentTaskId/includeSubProjects/projectPresenceFilter/subjectProductPresenceFilter. Search matches both task and subject-product names. Pass topLevelOnly=true to exclude checklist subtasks; pass includeSubProjects=true with projectId to also match tasks in that project\'s live descendant sub-projects. Presence filters widen an accompanying id selection: {subjectProductId, subjectProductPresenceFilter:"none"} means that product OR no product.',
      get: "Get a task by ID, including its optional subject product, blocked-by/blocking task ids, parent task (if a subtask), and subtask counts.",
      create:
        "Create a task (status not_started|later|in_progress|blocked|done), optionally attached to a project and/or a subjectProductId describing what the work is for. Set parentTaskId to create it as a checklist subtask of another task — one level only; projectId and subjectProductId are each inherited from the parent when omitted. A subtask can later change either relation independently. A subtask's own status is independent — the parent never auto-completes.",
      update:
        "Update a task's fields, including setting or clearing subjectProductId; `blockedByIds` replaces the full set of tasks blocking this one. `parentTaskId` can be set/changed/cleared, subject to the one-level rule (a task with subtasks can't become a subtask, and a subtask can't itself be a parent).",
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
    entity: "expense",
    createInput: expenseCreateInput.shape,
    updateShape: expenseUpdateData.shape,
    filterFields: expenseFilterFields,
    mcpListOut: expenseMcpListOut,
    out: expenseOut,
    slim: slimExpense,
    sort: { orderBy: "date", direction: "desc" },
    descriptions: {
      list: 'List expenses (project spend ledger) with cost, date, costType/trade, project name, and the vendor/charge this line is attributed to. Filter by costType/trade/projectId/future/search/notesSearch/urlSearch/includeSubProjects/dateFrom/dateTo (inclusive YYYY-MM-DD bounds on expense date)/costMin/costMax/productId/vendorId/orderId/purchaseId. search matches the expense NAME and accepts several terms, which OR — pass ["dust","vacuum"] when you are guessing at synonyms, because this ledger names the THING rather than the product (a Festool vacuum is booked as "dust extractor", a Bosch miter saw as "chop saw"). notesSearch and urlSearch are separate substring filters on those columns and AND with the name search; notes carry import provenance and url often holds a bare pre-roster store name. costMin/costMax are INCLUSIVE bounds on cost in dollars and are SIGNED — credits are real here (refunds, family contributions), so costMax: 0 is the credits-only worklist and there is no implicit lower bound of zero. A row with no cost recorded falls out of any cost window (use costPresenceFilter: "none" to find those instead). Pass includeSubProjects=true with projectId to match the whole live subtree under that project, not just its own expenses. projectPresenceFilter="none" is the unassigned-spend worklist and "has" is attributed spend; combined with projectId it WIDENS rather than narrows — {projectId, projectPresenceFilter:"none"} means that project OR unassigned. productPresenceFilter/vendorPresenceFilter follow the same "none"/"has" shape against productId/vendorId; vendorPresenceFilter="none" is also "no charge attached" (a charge always has a vendor, so no vendor and no charge are the same predicate). costPresenceFilter="none" finds lines with no cost recorded yet — combine with trade:"other" for the Unclassified-spend worklist. orderIdPresenceFilter splits on whether the line\'s charge carries a vendor order id ("none" = the ~40% that don\'t); orderId is an EXACT match on that id, meaningful only alongside vendorId (an order id is unique per vendor, not globally). purchaseId is the precise "every line of THIS charge" scope — an exact match on the charge\'s own id (from list_purchases/get_purchase), needing no vendorId/orderId pairing since the id alone identifies the charge.',
      get: "Get an expense by ID.",
      create:
        "Log an expense (costType materials|tools|services; set future=true for planned spend), optionally attached to a project.",
      update: "Update an expense's fields.",
      delete: "Soft-delete expenses by IDs.",
    },
    create: (caller, params) => caller.expense.create(params),
  });

  registerRouterTool(server, {
    name: "get_expense_analytics",
    description:
      'Spend aggregates over the expense ledger, under the SAME filters as list_expenses (costType/trade/projectId/includeSubProjects/future/search/notesSearch/urlSearch/dateFrom/dateTo/costMin/costMax/costPresenceFilter/projectPresenceFilter/vendorId/orderId), so ledger and analytics totals always agree. Returns summary (actual/committed/credits/net + counts), byCostType, byTrade, the trade x costType matrix, monthly totals, a cumulative net curve, byProject, and byVendor. Answers "what did we spend on X / where did the money go" without paging the ledger. Note: credits are real (refunds, family contributions) — net = actual + committed − credits, and cost bounds are signed, so costMax: 0 is the credits-only window. byProject and byVendor are INNER joins and deliberately do NOT sum to summary.net: byProject drops expenses with no project, byVendor drops the ~193 with no charge attached (no vendor recorded). Read each gap as the size of that unattributed tail, not as a bug.',
    inputSchema: expenseFilterFields,
    outputSchema: expenseAnalyticsOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.expense.analytics(params),
  });

  registerRouterTool(server, {
    name: "bulk_move_expenses",
    description:
      "Move many expenses onto one project at once; pass projectId: null to move them back to the Inbox (no project). Use after list_expenses to file loose or mis-attributed spend. Returns the updated rows and a count.",
    inputSchema: expenseBulkMoveInput.shape,
    outputSchema: expenseBulkMcpOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => bulkEntityWrite(caller.expense.bulkMove(params)),
  });

  registerRouterTool(server, {
    name: "bulk_set_expense_trade",
    description:
      "Set the same trade on many expenses at once (the 19-slug trade taxonomy shared with tasks and sub-projects — electrical|plumbing|countertop|…|other). Trade is required, not nullable: pass `other` rather than clearing it. Use after list_expenses (filter trade to find unclassified spend). Returns the updated rows and a count.",
    inputSchema: expenseBulkTradeInput.shape,
    outputSchema: expenseBulkMcpOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) =>
      bulkEntityWrite(caller.expense.bulkSetTrade(params)),
  });

  registerRouterTool(server, {
    name: "bulk_set_expense_cost_type",
    description:
      "Set the same costType on many expenses at once (materials|tools|services). Required, not nullable. Use after list_expenses to reclassify a batch of ledger lines so get_expense_analytics' byCostType split is right. Returns the updated rows and a count.",
    inputSchema: expenseBulkCostTypeInput.shape,
    outputSchema: expenseBulkMcpOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) =>
      bulkEntityWrite(caller.expense.bulkSetCostType(params)),
  });
}
