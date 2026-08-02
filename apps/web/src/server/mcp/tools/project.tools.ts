/**
 * Project-tracker MCP tools — projects / tasks / expenses, DB-backed.
 * Successor of the retired Notion-proxy tools (notion.tools.ts): same
 * list_projects/list_tasks/list_expenses surface plus full CRUD. A project's
 * former Notion page body now lives on `notes` (markdown), returned by
 * get_project.
 */

import { projectShortcode } from "@cubby/schemas/identifiers";
import {
  actionableTasksOut,
  deleteExpensesWithPurchaseEffectsInput,
  deleteExpensesWithPurchaseEffectsOut,
  expenseAnalyticsOut,
  expenseCreateInput,
  expenseFilterFields,
  expenseMatchInput,
  expenseMatchOut,
  expenseMcpListOut,
  expenseOut,
  expenseUpdateData,
  LIVE_PROJECT_STATUSES,
  productProjectUsesInput,
  productProjectUsesOut,
  projectAttentionItemSchema,
  projectCreateInput,
  projectDashboardFiltersSchema,
  projectDashboardSummaryOut,
  projectFilterFields,
  projectMcpListOut,
  projectOut,
  projectPortfolioAnalyticsOut,
  projectTaskStatusBreakdown,
  projectToolMutationInput,
  projectToolMutationOut,
  projectToolProjectInput,
  projectToolSuggestionsOut,
  projectToolsOut,
  projectUpdateData,
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
  strictFilterInput,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
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
 * task; `get_task` / `list_actionable_tasks` own the blocking graph. `taskOut`'s
 * own `id` and `projectId` ARE shortcodes now, so they're picked directly.
 * Product relationships use their canonical public shortcode in
 * `subjectProductId`, matching the task contract. */
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

/** `attention[].entityId` already carries the public code (see
 * `repo/project/attention.ts`, which selects `row.shortcode` into it), and
 * `projectTaskStatusBreakdown.projectId` is a `projectShortcode` — so both
 * pass straight through. */
const houseStatusAttentionItem = projectAttentionItemSchema;
const houseStatusTaskStatus = projectTaskStatusBreakdown;

/** `project.dashboardSummary` minus `filterOptions` (UI select options only). */
const houseStatusOut = projectDashboardSummaryOut
  .omit({
    filterOptions: true,
    projects: true,
    taskStatusByProject: true,
    nextTasks: true,
    attention: true,
  })
  .extend({
    projects: z.array(houseStatusProject),
    taskStatusByProject: z.array(houseStatusTaskStatus),
    nextTasks: z.array(houseStatusTask),
    attention: z.array(houseStatusAttentionItem),
  });

/** One project's planned-vs-actual envelope, derived from
 * `portfolioAnalytics.costVsEstimate` (subtree lifetime totals). Its
 * `projectId` IS the public shortcode, so no reverse lookup is needed. */
const projectBudgetRow = z.object({
  projectId: projectShortcode,
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

/** `expenseMatchCandidate.expenseId` is already the public code. */
const expenseMatchCandidateMcpOut =
  expenseMatchOut.shape.matches.element.shape.candidates.element;

const expenseMatchMcpOut = expenseMatchOut.omit({ matches: true }).extend({
  matches: z.array(
    expenseMatchOut.shape.matches.element.omit({ candidates: true }).extend({
      candidates: z.array(expenseMatchCandidateMcpOut),
    }),
  ),
});

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
    name: "list_project_tools",
    description:
      "List the durable tools explicitly used on one exact project, including each tool's net lifetime cost, distinct project-use count, cost per use, and whether it was purchased for this project. Sub-project uses remain separate and count independently.",
    inputSchema: projectToolProjectInput.shape,
    outputSchema: projectToolsOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.project.tools(params),
  });

  registerRouterTool(server, {
    name: "suggest_project_tools",
    description:
      "Suggest inventoried Cubby tools to attach to one exact project. Suggestions include tools purchased for the project at $100+ and trade-matched tools whose purchase history supports the project's task/expense trades; cheaper trade matches require at least two explicit prior project uses. This is a review queue only and never attaches tools automatically.",
    inputSchema: projectToolProjectInput.shape,
    outputSchema: projectToolSuggestionsOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.project.toolSuggestions(params),
  });

  registerRouterTool(server, {
    name: "attach_project_tools",
    description:
      "Record that one or more existing Cubby tool products were used on one exact project. Repeating an existing live association is idempotent. This does not alter project spend or the product's expense history.",
    inputSchema: projectToolMutationInput.shape,
    outputSchema: projectToolMutationOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => caller.project.attachTools(params),
  });

  registerRouterTool(server, {
    name: "detach_project_tools",
    description:
      "Soft-delete one or more explicit tool-use associations from one exact project. This leaves the Product, Expenses, inventory, and any uses on other projects unchanged.",
    inputSchema: projectToolMutationInput.shape,
    outputSchema: projectToolMutationOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    call: (caller, params) => caller.project.detachTools(params),
  });

  registerRouterTool(server, {
    name: "list_product_project_uses",
    description:
      "Show every exact project on which a Cubby tool product is explicitly recorded as used, plus its net lifetime cost, distinct project-use count, cost per use, and whether the tool was purchased for each project.",
    inputSchema: productProjectUsesInput.shape,
    outputSchema: productProjectUsesOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.product.projectUses(params),
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
    call: async (caller, params) => {
      const result = await caller.project.dashboardSummary({
        statusScope: [...LIVE_PROJECT_STATUSES],
        ...params,
      });
      return result;
    },
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
    batch: { update: true },
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
      list: 'List expenses (project spend ledger) with cost, date, costType/trade, project name, and the vendor/purchase this Expense is attributed to. Filter by costType/trade/projectId/future/search/notesSearch/urlSearch/includeSubProjects/dateFrom/dateTo (inclusive YYYY-MM-DD bounds on expense date)/costMin/costMax/productId/vendorId/orderId/purchaseId. search matches the expense NAME and accepts several terms, which OR — pass ["dust","vacuum"] when you are guessing at synonyms, because this ledger names the THING rather than the product (a Festool vacuum is booked as "dust extractor", a Bosch miter saw as "chop saw"). notesSearch and urlSearch are separate substring filters on those columns and AND with the name search; notes carry import provenance and url often holds a bare pre-roster store name. costMin/costMax are INCLUSIVE bounds on cost in dollars and are SIGNED — credits are real here (refunds, family contributions), so costMax: 0 is the credits-only worklist and there is no implicit lower bound of zero. A row with no cost recorded falls out of any cost window (use costPresenceFilter: "none" to find those instead). Pass includeSubProjects=true with projectId to match the whole live subtree under that project, not just its own expenses. projectPresenceFilter="none" is the unassigned-spend worklist and "has" is attributed spend; combined with projectId it WIDENS rather than narrows — {projectId, projectPresenceFilter:"none"} means that project OR unassigned. productPresenceFilter/vendorPresenceFilter follow the same "none"/"has" shape against productId/vendorId; vendorPresenceFilter="none" is also "no purchase attached" (a purchase always has a vendor, so no vendor and no purchase are the same predicate). costPresenceFilter="none" finds expenses with no cost recorded yet — combine with trade:"other" for the Unclassified-spend worklist. orderIdPresenceFilter splits on whether the Expense\'s purchase carries a vendor order id ("none" = the ~40% that don\'t); orderId is an EXACT match on that id, meaningful only alongside vendorId (an order id is unique per vendor, not globally). purchaseId is the precise "every Expense in THIS purchase" scope — an exact match on the purchase\'s own id (from list_purchases/get_purchase), needing no vendorId/orderId pairing since the id alone identifies the purchase.',
      get: "Get an expense by ID.",
      create:
        "Log an expense (costType materials|tools|services; set future=true for planned spend), optionally attached to a project.",
      update: "Update an expense's fields.",
    },
    create: (caller, params) => caller.expense.create(params),
    operations: { delete: false },
    batch: { create: true, update: true },
    resolveUpdateData: async (_caller, data) =>
      data.productId === undefined
        ? data
        : {
            ...data,
            productId: data.productId,
          },
  });

  registerRouterTool(server, {
    name: "delete_expenses",
    description:
      "Soft-delete up to 200 distinct expenses atomically. Returns the deleted expense IDs, every Purchase affected, and the subset that now has no live Expenses; use the latter to inspect before deleting an empty Purchase. This does not delete Purchases or settlement records.",
    inputSchema: deleteExpensesWithPurchaseEffectsInput,
    outputSchema: deleteExpensesWithPurchaseEffectsOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    call: (caller, params) => caller.expense.deleteWithPurchaseEffects(params),
  });

  registerRouterTool(server, {
    name: "get_expense_analytics",
    description:
      'Spend aggregates over the expense ledger, under the SAME filters as list_expenses (costType/trade/projectId/includeSubProjects/future/search/notesSearch/urlSearch/dateFrom/dateTo/costMin/costMax/costPresenceFilter/projectPresenceFilter/vendorId/orderId), so ledger and analytics totals always agree. Returns summary (actual/committed/credits/net + counts), byCostType, byTrade, the trade x costType matrix, monthly totals, a cumulative net curve, byProject, and byVendor. Answers "what did we spend on X / where did the money go" without paging the ledger. Note: credits are real (refunds, family contributions) — net = actual + committed − credits, and cost bounds are signed, so costMax: 0 is the credits-only window. byProject and byVendor are INNER joins and deliberately do NOT sum to summary.net: byProject drops expenses with no project, byVendor drops the ~193 with no purchase attached (no vendor recorded). Read each gap as the size of that unattributed tail, not as a bug.',
    // Strict: this tool takes `expenseFilterFields` directly rather than going
    // through registerEntityListTool, so it needs its own guard against a
    // silently-ignored filter key. No reserved keys — there's no pagination here.
    inputSchema: strictFilterInput(
      "get_expense_analytics",
      expenseFilterFields,
      expenseFilterFields,
    ),
    outputSchema: expenseAnalyticsOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.expense.analytics(params),
  });

  registerRouterTool(server, {
    name: "match_expenses",
    description:
      "Rank existing ledger rows as candidate matches for lines of a vendor export (an Amazon takeout row, an eBay OrdersReport line, a receipt). Pass up to 200 rows, each with your own `key` plus `date` and a SIGNED `amount`, optionally `label` (the export's description), `orderId` and `vendor`. Returns, per key, up to `maxCandidatesPerRow` candidates carrying expenseId/name/cost/date/vendorName/orderId/projectName/productName plus the evidence to judge them: `matchedOn` (order_id | amount_date), `dayDelta`, `amountDelta`, `ratio`, `ratioLabel` and `tokenOverlap`. Also returns `unmatched` keys and a summary. " +
      "WARNING — this RANKS candidates, it does not VERIFY them, and it never writes anything. Run it BEFORE proposing any new expense, and again over each row you did create (same amount, ±30 days) to catch what slipped through. Then confirm every match with the user before a single update_expense or create_expense call. " +
      "Read `tokenOverlap` as a hint and NOTHING more. Zero overlap is routine on TRUE matches, because this ledger names the THING, not the product: a Festool vacuum is booked as `dust extractor`, a Bosch miter saw as `chop saw`. That is the exact trap this tool exists for — a keyword search for 'festool' found nothing and a duplicate row was added while the real one had sat there since 2024. Never discard a zero-overlap candidate on that basis, and note that tokenizers also miss compound words (`labelmaker` vs 'label maker', `stepstool` vs 'step stool'). Conversely, high overlap on a coincidental amount is not evidence either. " +
      "**Below about $20, READ the line descriptions before accepting anything.** A $0.93 order matched a $1.00 `5 yd nursery mix` row on amount+date and had to be reverted. Small amounts are inside any usable band by construction; the tool will surface them, and only you can tell them apart. " +
      "Genuine matches cluster at `dayDelta` 0–1. Candidates scattered across a ±14d window are usually coincidences — in one pass 209 amount matches graded down to 97 real ones. " +
      "`ratioLabel` classifies cost/amount against `taxRate` as exact | plus_tax | pre_tax | other. It LABELS, it does not match: matching uses one wide window, because tax is multiplicative while fees are additive and no single band catches both. So read the raw `amountDelta` on an `other` — a residual of exactly 9.99 or 12.50 is shipping, which a tax-hypothesis check would have silently rejected. Pre-tax entry is a recurring bug class (24 rows in one pass), which is what `pre_tax` is there to make visible. " +
      '**Always pass `orderId` when the export line has one — and pass `vendor` with it.** An order id is only unique WITHIN a vendor, so a short one (Tool Nirvana\'s "#11325") genuinely collides across retailers. Without `vendor` the matcher cannot tell a collision from a real hit, and an order-id candidate otherwise takes the top slot. Each candidate reports `vendorMatch`: true (agrees), false (CONFLICTS — treat as almost certainly the wrong row; it is demoted below every amount+date candidate but still returned, because the two spellings may just differ), or null (nothing to compare, which is unknown rather than clean). It is the only key that catches BOTH directions of the aggregate problem: a ledger row may AGGREGATE several export lines at an amount that reconciles to nothing, and it may equally hold the SPLIT while you search for the total (B&H order 1121197219 was already two sibling rows, so an amount+date search for its $306.27 total found nothing and a duplicate aggregate was created). The order-id arm ignores the day window on purpose. ' +
      "An empty `candidates` list means 'nothing within the window', NOT 'this expense is missing' — an aggregate row covering your line can sit at an amount no formula relates to yours. Rows with no cost or no date recorded are outside every amount window by construction. Planned (`future: true`) rows are included and flagged, never filtered: an export line often turns out to be one. When one ledger row is the best candidate for two export lines it is returned for both — resolve that yourself rather than assuming a one-to-one assignment.",
    inputSchema: expenseMatchInput.shape,
    outputSchema: expenseMatchMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) => {
      return await caller.expense.match(params);
    },
  });
}
