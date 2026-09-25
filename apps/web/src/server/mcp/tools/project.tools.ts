/**
 * Project-tracker MCP tools — projects / tasks / expenses, DB-backed.
 * Successor of the retired Notion-proxy tools (notion.tools.ts): same
 * workflow and synthesis surface. A project's
 * former Notion page body now lives on `notes` (markdown), returned by
 * get_project.
 */

import { projectShortcode } from "@cubby/schemas/identifiers";
import { projectResourceFeatureLabels } from "@cubby/schemas/product-category-fields";
import {
  actionableTasksOut,
  expenseAnalyticsOut,
  expenseFilterFields,
  expenseMatchInput,
  expenseMatchOut,
  LIVE_PROJECT_STATUSES,
  projectAttentionItemSchema,
  projectDashboardFiltersSchema,
  projectDashboardSummaryOut,
  projectOut,
  projectPortfolioAnalyticsOut,
  projectResourceProjectInput,
  projectTaskStatusBreakdown,
  repointProjectUsesInput,
  repointProjectUsesOut,
  taskOut,
  taskSummaryOut,
} from "@cubby/schemas/project";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sumBy } from "es-toolkit";
import { z } from "zod";

import { projectContract } from "~/contracts/project.contract";
import {
  expenseAnalyticsWorkflow,
  expenseMatchWorkflow,
} from "~/server/workflows/expense.server";
import {
  projectDashboardSummaryWorkflow,
  projectPortfolioAnalyticsWorkflow,
  projectRepointUsesWorkflow,
  projectResourcesWorkflow,
} from "~/server/workflows/project.server";
import {
  taskListActionableWorkflow,
  taskSummaryWorkflow,
} from "~/server/workflows/task.server";

import {
  READ_ONLY_CLOSED,
  registerRouterTool,
  strictFilterInput,
  WRITE_CLOSED,
} from "./_shared";
import { fromContract, mcpItemsEnvelope } from "./contract-envelope";

/** `{items}` over `project.resources`'s own output — see `mcpItemsEnvelope`. */
const projectResourcesMcpOut = mcpItemsEnvelope(
  fromContract(projectContract.ops.resources),
);

// Synthesis-read / bulk-write projections
//
// These trim the router outputs the same way the slim* projections trim list
// rows: the handler passes the router payload straight through and the output
// schema's parse drops the keys below (zod objects strip unknown keys), so a
// new field on the underlying schema flows through without an MCP-side edit.

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
  registerRouterTool(server, {
    name: "list_project_resources",
    description:
      "List the reusable tools and software explicitly used on one exact project. Tools include lifetime acquisition/use economics; software includes non-additive household spend charged during the project's effective window. Sub-project uses remain separate and count independently.",
    inputSchema: projectResourceProjectInput,
    // `{items}`, like every other list tool — see `projectResourcesMcpOut`.
    outputSchema: projectResourcesMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (context, params) => ({
      items: await projectResourcesWorkflow(context.readDb, params),
    }),
  });

  // The prose that used to be `attach_project_resources`' /
  registerRouterTool(server, {
    name: "repoint_project_uses",
    description: `Move a Product's recorded project uses onto another Product, in one transaction. This is the tool for retiring or splitting a Product that delete_entity refuses because it has project-use history: repoint the history onto the component or replacement that should carry it, then delete. Do NOT do this as detach_entity plus attach_entity — a detach whose attach is missed discards the project's tool history with nothing to flag it, which is exactly why this stayed its own tool when those six collapsed into two. Omit projectIds to move every live use. Projects that already record the destination keep their existing row and are reported as alreadyPresent, not as an error. The destination must be a live Product in a category that allows project resources (${projectResourceFeatureLabels}).`,
    inputSchema: repointProjectUsesInput,
    outputSchema: repointProjectUsesOut,
    annotations: WRITE_CLOSED,
    call: (context, params) =>
      projectRepointUsesWorkflow(context.db, params, context.actorContext),
  });

  registerRouterTool(server, {
    name: "get_house_status",
    description:
      'What needs attention around the house, in one call. Returns portfolio counts (active projects, open tasks, actual vs committed spend), the active projects with own + subtree rollups, a per-project task-status breakdown, the next upcoming tasks, and `attention[]` — overdue tasks, stalled projects, past-due planned expenses, missing budgets, unclassified expenses and blocked work, each with a severity, the entity it points at, and a link. Start here for "how are the projects going" / "what should I deal with", then drill in with entity get(project) or list(task). Optional filters scope it to a status set, project kinds, locations, a search term, or a date window (dateFrom/dateTo — a project matches when its startDate/endDate override overlaps the window OR it has a task or expense of its own inside it; only projects with no override and no dated content at all are dropped, and that count comes back as hiddenByDate.projects). statusScope defaults to the live statuses (planning/not_started/in_progress) when omitted, so this payload does not balloon with completed history — pass statusScope explicitly (e.g. ["done"]) to include finished projects.',
    inputSchema: projectDashboardFiltersSchema,
    outputSchema: houseStatusOut,
    annotations: READ_ONLY_CLOSED,
    // `projectDashboardFiltersSchema`'s own default is changing to "no status
    // condition" (all four statuses) — this tool mirrors the UI's Overview
    // default instead, so its payload doesn't balloon with completed-project
    // history when the caller doesn't specify a scope. Behavior-preserving
    // today: `ne(status,'done')` (the old default) is equivalent to
    // `inArray(LIVE_PROJECT_STATUSES)` given exactly 4 statuses.
    call: (context, params) =>
      projectDashboardSummaryWorkflow(context.readDb, {
        statusScope: [...LIVE_PROJECT_STATUSES],
        ...params,
      }),
  });

  registerRouterTool(server, {
    name: "get_project_budget",
    description:
      "Which projects are over budget: per project, the subtree budget estimate vs actual + committed spend, with remaining, percentUsed and an overBudget flag, sorted worst-overrun first (unbudgeted projects last). Also returns portfolio totals and planned-vs-actual spend by month. Same optional scope filters as get_house_status (status set, project kinds, locations, search, dateFrom/dateTo), but statusScope defaults to no condition (all four statuses, including done) — a budget tool silently omitting completed spend would be a bug, not a feature. dateFrom/dateTo scope the whole query, not just the monthly series: while a window is set, a project is kept when its startDate/endDate override overlaps it OR it owns a task or expense inside it, and only projects with no dates from any source drop out of the per-project figures.",
    inputSchema: projectDashboardFiltersSchema,
    outputSchema: projectBudgetOut,
    annotations: READ_ONLY_CLOSED,
    call: async (context, params) => {
      const analytics = await projectPortfolioAnalyticsWorkflow(
        context.readDb,
        params,
      );
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

      // Totals sum SCOPE ROOTS only. Every row is a subtree rollup, so
      // totalling all of them counts an in-scope child twice — once in its own
      // row and once inside its parent's. The rows themselves stay complete;
      // only the totals are deduplicated.
      const scopeRoots = projects.filter((p) => p.isScopeRoot);

      return {
        projects,
        totals: {
          estimate: sumBy(scopeRoots, (p) => p.estimate ?? 0),
          actual: sumBy(scopeRoots, (p) => p.actual),
          committed: sumBy(scopeRoots, (p) => p.committed),
          projected: sumBy(scopeRoots, (p) => p.projected),
          overBudgetCount: projects.filter((p) => p.overBudget).length,
          missingEstimateCount: projects.filter((p) => p.estimate === null)
            .length,
        },
        plannedVsActualByMonth: analytics.plannedVsActual,
      };
    },
  });

  registerRouterTool(server, {
    name: "list_actionable_tasks",
    description:
      "Unblocked tasks you can act on now — live, not done, and blocked by nothing — plus blocked tasks with transitive why-chains explaining what's in the way (a manual blocked flag, a blocking task, or a blocking project, nearest blocker first).",
    inputSchema: z.object({}),
    outputSchema: actionableTasksOut,
    annotations: READ_ONLY_CLOSED,
    call: (context) => taskListActionableWorkflow(context.readDb, undefined),
  });

  registerRouterTool(server, {
    name: "get_task_summary",
    description:
      "Task counts across the whole tracker in one cheap call: totalOpen, next (unblocked and actionable now), later, inbox (tasks with no project), overdue, dueThisWeek (rolling 7 days), blocked. Use it to size the backlog before paging entity list(task).",
    inputSchema: z.object({}),
    outputSchema: taskSummaryOut,
    annotations: READ_ONLY_CLOSED,
    call: (context) => taskSummaryWorkflow(context.readDb),
  });

  registerRouterTool(server, {
    name: "get_expense_analytics",
    description:
      "Spend aggregates over the expense ledger, under the same filters as entity list(expense) (lineKind/costType/trade/projectId/includeSubProjects/future/search/notesSearch/urlSearch/dateFrom/dateTo/costMin/costMax/costPresenceFilter/projectPresenceFilter/vendorId/orderId), so ledger and analytics totals always agree. Returns summary (all line kinds), adjustments (the signed non-principal aggregate), principal-only byCostType/byTrade/trade x costType, and all-kind monthly, cumulative, byProject, and byVendor totals. Use summary.net = sum(Expense.cost); reconcile a category or trade total to it by adding adjustments.net. Credits are real (refunds and price adjustments) — net = actual + committed − credits, and cost bounds are signed, so costMax: 0 is the credits-only window. byProject and byVendor are INNER joins and deliberately do NOT sum to summary.net: byProject drops expenses with no project, byVendor drops rows with no purchase attached. Read each gap as the size of that unattributed tail, not as a bug.",
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
    call: (context, params) => expenseAnalyticsWorkflow(context.readDb, params),
  });

  registerRouterTool(server, {
    name: "match_expenses",
    description:
      "Rank existing ledger rows as candidate matches for lines of a vendor export (an Amazon takeout row, an eBay OrdersReport line, a receipt). Pass up to 200 rows, each with your own `key` plus `date` and a SIGNED `amount`, optionally `label` (the export's description), `orderId` and `vendor`. Returns, per key, up to `maxCandidatesPerRow` candidates carrying expenseId/name/cost/date/vendorName/orderId/projectName/productName plus the evidence to judge them: `matchedOn` (order_id | amount_date), `dayDelta`, `amountDelta`, `ratio`, `ratioLabel` and `tokenOverlap`. Also returns `unmatched` keys and a summary. " +
      "WARNING — this RANKS candidates, it does not VERIFY them, and it never writes anything. Run it BEFORE proposing any new expense, and again over each row you did create (same amount, ±30 days) to catch what slipped through. Then confirm every match with the user before entity update(expense) or create(expense). " +
      "Read `tokenOverlap` as a hint and NOTHING more. Zero overlap is routine on TRUE matches, because this ledger names the THING, not the product: a Festool vacuum is booked as `dust extractor`, a Bosch miter saw as `chop saw`. That is the exact trap this tool exists for — a keyword search for 'festool' found nothing and a duplicate row was added while the real one had sat there since 2024. Never discard a zero-overlap candidate on that basis, and note that tokenizers also miss compound words (`labelmaker` vs 'label maker', `stepstool` vs 'step stool'). Conversely, high overlap on a coincidental amount is not evidence either. " +
      "**Below about $20, READ the line descriptions before accepting anything.** A $0.93 order matched a $1.00 `5 yd nursery mix` row on amount+date and had to be reverted. Small amounts are inside any usable band by construction; the tool will surface them, and only you can tell them apart. " +
      "Genuine matches cluster at `dayDelta` 0–1. Candidates scattered across a ±14d window are usually coincidences — in one pass 209 amount matches graded down to 97 real ones. " +
      "`ratioLabel` classifies cost/amount against `taxRate` as exact | plus_tax | pre_tax | other. It LABELS, it does not match: matching uses one wide window, because tax is multiplicative while fees are additive and no single band catches both. So read the raw `amountDelta` on an `other` — a residual of exactly 9.99 or 12.50 is shipping, which a tax-hypothesis check would have silently rejected. Pre-tax entry is a recurring bug class (24 rows in one pass), which is what `pre_tax` is there to make visible. " +
      '**Always pass `orderId` when the export line has one — and pass `vendor` with it.** An order id is only unique WITHIN a vendor, so a short one (Tool Nirvana\'s "#11325") genuinely collides across retailers. Without `vendor` the matcher cannot tell a collision from a real hit, and an order-id candidate otherwise takes the top slot. Each candidate reports `vendorMatch`: true (agrees), false (CONFLICTS — treat as almost certainly the wrong row; it is demoted below every amount+date candidate but still returned, because the two spellings may just differ), or null (nothing to compare, which is unknown rather than clean). It is the only key that catches BOTH directions of the aggregate problem: a ledger row may AGGREGATE several export lines at an amount that reconciles to nothing, and it may equally hold the SPLIT while you search for the total (B&H order 1121197219 was already two sibling rows, so an amount+date search for its $306.27 total found nothing and a duplicate aggregate was created). The order-id arm ignores the day window on purpose. ' +
      "An empty `candidates` list means 'nothing within the window', NOT 'this expense is missing' — an aggregate row covering your line can sit at an amount no formula relates to yours. Rows with no cost or no date recorded are outside every amount window by construction. Planned (`future: true`) rows are included and flagged, never filtered: an export line often turns out to be one. When one ledger row is the best candidate for two export lines it is returned for both — resolve that yourself rather than assuming a one-to-one assignment.",
    inputSchema: expenseMatchInput,
    outputSchema: expenseMatchMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: (context, params) => expenseMatchWorkflow(context.readDb, params),
  });
}
