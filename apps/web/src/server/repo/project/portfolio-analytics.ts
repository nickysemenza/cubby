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
import type { ProjectId } from "@cubby/schemas/identifiers";
import type {
  ProjectPortfolioAnalyticsInput,
  ProjectPortfolioAnalyticsOut,
} from "@cubby/schemas/project";
import {
  and,
  asc,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import type { Database } from "~/server/db";
import { expense, project, task } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  EXPENSE_MONTH_BUCKET,
  expenseAggregateFields,
} from "~/server/repo/expense-aggregate-sql";
import { buildDashboardProjectWhere } from "./dashboard-shared";
import { EMPTY_PROJECT_SUBTREE_ROLLUP } from "./helpers";
import { loadProjectSubtreeRollups } from "./subtree";

const EMPTY_OUT: ProjectPortfolioAnalyticsOut = {
  costVsEstimate: [],
  spendingByProject: [],
  monthlySpend: [],
  plannedVsActual: [],
  tradeActivity: [],
  taskHeatmap: [],
};

export async function projectPortfolioAnalytics(
  db: Database,
  filters: ProjectPortfolioAnalyticsInput,
): Promise<ProjectPortfolioAnalyticsOut> {
  const projectRows = await getDb(db).query.project.findMany({
    where: buildDashboardProjectWhere(filters),
    orderBy: [asc(project.name)],
    columns: { id: true, name: true },
  });
  const ids = projectRows.map((r) => r.id);
  if (ids.length === 0) return EMPTY_OUT;

  const nameById = new Map(projectRows.map((r) => [r.id, r.name]));
  const { subtreeRollups } = await loadProjectSubtreeRollups(db, ids);

  const costVsEstimate = ids.map((id) => {
    const subtree = subtreeRollups.get(id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP;
    return {
      projectId: id,
      projectName: nameById.get(id) ?? "",
      actual: subtree.actualSpent,
      committed: subtree.committedSpent,
      estimate: subtree.costEstimate,
    };
  });

  const spendingByProject = ids
    .map((id) => ({
      projectId: id,
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
  const expenseScope = and(
    inArray(expense.projectId, ids),
    notDeleted(expense),
    filters.dateFrom ? gte(expense.date, filters.dateFrom) : undefined,
    filters.dateTo ? lte(expense.date, filters.dateTo) : undefined,
  );
  const expenseScopeWithDate = and(expenseScope, isNotNull(expense.date));

  const [monthlyRows, plannedVsActualRows, tradeRows, taskHeatmapRows] =
    await Promise.all([
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
        .where(expenseScope)
        .groupBy(expense.trade),
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
    projectId: id,
    projectName: nameById.get(id) ?? "",
    openTaskCount: openTaskCountByProject.get(id) ?? 0,
  }));

  return {
    costVsEstimate,
    spendingByProject,
    monthlySpend: monthlyRows,
    plannedVsActual: plannedVsActualRows,
    tradeActivity: tradeRows,
    taskHeatmap,
  };
}
