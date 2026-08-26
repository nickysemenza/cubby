/**
 * `project.portfolioAnalytics` — the chart aggregates that used to ride
 * along in `project.dashboard`'s full task/expense arrays (client-side
 * reduced by projects-dashboard.tsx), now computed server-side and loaded
 * only when the Charts/Analytics tab is selected. Scoped by the same
 * `statusScope`/`kinds`/`locations`/`search`/`dateFrom`/`dateTo` filters as
 * `dashboardSummary` (`buildDashboardProjectWhere`, see `dashboard-shared.ts`).
 *
 * The `dateFrom`/`dateTo` window does TWO things, not one:
 *   - it narrows the PROJECT SET itself (interval-overlap against each
 *     project's `[startDate, endDate]`, baked into `buildDashboardProjectWhere`
 *     via `dashboardProjectDateCondition`) — so `costVsEstimate`,
 *     `spendingByProject`, and `taskHeatmap` ARE scoped by it too, even though
 *     each still reports a project's LIFETIME actual/committed/spend/
 *     openTaskCount (the same subtree rollup shown on project cards, which has
 *     no date axis of its own): a project outside the window just doesn't
 *     appear in `ids` at all, rather than having its totals date-clipped;
 *   - it additionally bounds `expense.date` directly for the expense-grouped
 *     aggregates (`monthlySpend`/`plannedVsActual`/`tradeActivity`), which need
 *     it to bucket by month in the first place.
 */
import { type ProjectId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  ProjectPortfolioAnalyticsInput,
  ProjectPortfolioAnalyticsOut,
} from "@cubby/schemas/project";
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { expense, project, task } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { buildExpenseWhereClause } from "~/server/repo/expense";
import {
  EXPENSE_MONTH_BUCKET,
  expenseAggregateFields,
} from "~/server/repo/expense-aggregate-sql";
import { buildDashboardProjectWhere } from "./dashboard-shared";
import { EMPTY_PROJECT_SUBTREE_ROLLUP } from "./helpers";
import { loadProjectSubtreeRollups, projectCompletionYear } from "./subtree";

const EMPTY_OUT: ProjectPortfolioAnalyticsOut = {
  costVsEstimate: [],
  spendingByProject: [],
  monthlySpend: [],
  plannedVsActual: [],
  tradeActivity: [],
  adjustments: { actual: 0, committed: 0, credits: 0, net: 0, count: 0 },
  taskHeatmap: [],
};

export async function projectPortfolioAnalytics(
  db: Database,
  filters: ProjectPortfolioAnalyticsInput,
): Promise<ProjectPortfolioAnalyticsOut> {
  const wholeTree = filters.completionYear
    ? await loadProjectSubtreeRollups(db)
    : null;
  const completionIds = wholeTree
    ? wholeTree.allRows
        .filter((row) => {
          const window = wholeTree.dateWindows.get(row.id);
          return (
            window &&
            projectCompletionYear(row, window) === filters.completionYear
          );
        })
        .map((row) => row.id)
    : undefined;
  const projectRows = await getDb(db).query.project.findMany({
    where: buildDashboardProjectWhere(filters, completionIds),
    orderBy: [asc(project.name)],
    columns: { id: true, shortcode: true, name: true },
  });
  const ids = projectRows.map((r) => r.id);
  if (ids.length === 0) return EMPTY_OUT;

  const nameById = new Map(projectRows.map((r) => [r.id, r.name]));
  const shortcodeById = new Map(
    projectRows.map((r) => [r.id, parseShortcodeFor("project", r.shortcode)]),
  );
  const { subtreeRollups } =
    wholeTree ?? (await loadProjectSubtreeRollups(db, ids));

  const costVsEstimate = ids.map((id) => {
    const subtree = subtreeRollups.get(id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP;
    return {
      projectId: shortcodeById.get(id)!,
      projectName: nameById.get(id) ?? "",
      actual: subtree.actualSpent,
      committed: subtree.committedSpent,
      estimate: subtree.costEstimate,
    };
  });

  const spendingByProject = ids
    .map((id) => ({
      projectId: shortcodeById.get(id)!,
      projectName: nameById.get(id) ?? "",
      spend: (subtreeRollups.get(id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP).spent,
    }))
    .sort((a, b) => b.spend - a.spend);

  // Expense-based aggregates: expenses whose OWN projectId is in the
  // filtered set (not subtree-expanded — a sub-project's own expenses only
  // count here if the sub-project itself matched the filter; unlike
  // costVsEstimate/spendingByProject, which intentionally show subtree
  // totals). Inbox expenses (no project) are excluded — judgment call, see
  // the task report.
  //
  // Routed through the SAME `buildExpenseWhereClause` the ledger and
  // `expenseAnalytics` use, so `costMin`/`costMax`/`notesSearch`/`urlSearch`
  // and OR-search reach these charts too (they didn't before — a hand-rolled
  // date-only clause lived here). `ProjectPortfolioAnalyticsInput` is
  // project-shaped (`ProjectDashboardFilters`): only `dateFrom`/`dateTo` share
  // both a name and a meaning with `ExpenseFilters` — `filters.search` means
  // PROJECT name here and must never be forwarded as `ExpenseFilters.search`
  // (expense name). `statusScope`/`kinds`/`locations`/`completionYear`
  // already narrowed `ids` via `buildDashboardProjectWhere` above, so they
  // need no expense-side translation. The project-id scoping itself is the
  // `extraConditions` escape hatch: `ids` are already-resolved uuids, and
  // `buildExpenseWhereClause`'s own `projectId` filter expects shortcodes it
  // would have to resolve right back — round-tripping we'd rather skip.
  const expenseScope = await buildExpenseWhereClause(
    db,
    { dateFrom: filters.dateFrom, dateTo: filters.dateTo },
    { extraConditions: [inArray(expense.projectId, ids)] },
  );
  const expenseScopeWithDate = and(expenseScope, isNotNull(expense.date));

  const [
    monthlyRows,
    plannedVsActualRows,
    tradeRows,
    adjustmentRows,
    taskHeatmapRows,
  ] = await Promise.all([
    getDb(db)
      .select({
        month: sql<string>`${EXPENSE_MONTH_BUCKET}`,
        ...expenseAggregateFields(),
      })
      .from(expense)
      .where(expenseScopeWithDate)
      .groupBy(EXPENSE_MONTH_BUCKET)
      .orderBy(EXPENSE_MONTH_BUCKET),
    getDb(db)
      .select({
        month: sql<string>`${EXPENSE_MONTH_BUCKET}`,
        planned: sql<number>`coalesce(sum(${expense.cost}) filter (where ${expense.future} = true), 0)::float`,
        actual: sql<number>`coalesce(sum(${expense.cost}) filter (where ${expense.future} = false), 0)::float`,
      })
      .from(expense)
      .where(expenseScopeWithDate)
      .groupBy(EXPENSE_MONTH_BUCKET)
      .orderBy(EXPENSE_MONTH_BUCKET),
    getDb(db)
      .select({ trade: expense.trade, ...expenseAggregateFields() })
      .from(expense)
      .where(and(expenseScope, eq(expense.lineKind, "principal")))
      .groupBy(expense.trade),
    getDb(db)
      .select({ ...expenseAggregateFields() })
      .from(expense)
      .where(and(expenseScope, ne(expense.lineKind, "principal"))),
    getDb(db)
      .select({
        projectId: task.projectId,
        openTaskCount: sql<number>`count(*)::int`,
      })
      .from(task)
      .where(
        and(
          inArray(task.projectId, ids),
          notDeleted(task),
          ne(task.status, "done"),
          isNull(task.parentTaskId),
        ),
      )
      .groupBy(task.projectId),
  ]);

  const openTaskCountByProject = new Map<ProjectId, number>();
  for (const row of taskHeatmapRows) {
    if (row.projectId)
      openTaskCountByProject.set(row.projectId, row.openTaskCount);
  }
  const taskHeatmap = ids.map((id) => ({
    projectId: shortcodeById.get(id)!,
    projectName: nameById.get(id) ?? "",
    openTaskCount: openTaskCountByProject.get(id) ?? 0,
  }));

  return {
    costVsEstimate,
    spendingByProject,
    monthlySpend: monthlyRows,
    plannedVsActual: plannedVsActualRows,
    tradeActivity: tradeRows,
    adjustments: adjustmentRows[0]!,
    taskHeatmap,
  };
}
