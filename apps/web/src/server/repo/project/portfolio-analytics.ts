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
import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { expense, project, task } from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  uuidArrayParam,
} from "~/server/repo/database-helpers";
import { EXPENSE_MONTH_BUCKET } from "~/server/repo/expense-aggregate-sql";
import { effectiveExpenseTradeSql } from "~/server/repo/expense-inheritance";
import {
  expenseAllocatedCostSql,
  expenseAllocationExistsSql,
} from "~/server/repo/expense-project-allocation";
import { effectiveTaskProjectSql } from "~/server/repo/task-project-inheritance";

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

const aggregateForCost = (
  cost: ReturnType<typeof expenseAllocatedCostSql>,
) => ({
  actual: sql<number>`coalesce(sum(${cost}) filter (where ${cost} > 0 and ${expense.future} = false), 0)::float`,
  committed: sql<number>`coalesce(sum(${cost}) filter (where ${cost} > 0 and ${expense.future} = true), 0)::float`,
  credits: sql<number>`coalesce(-sum(${cost}) filter (where ${cost} < 0), 0)::float`,
  net: sql<number>`coalesce(sum(${cost}), 0)::float`,
  count: sql<number>`count(*)::int`,
});

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
  const subtreeLoad = wholeTree ?? (await loadProjectSubtreeRollups(db, ids));
  const { subtreeRollups } = subtreeLoad;

  // Each row below is a SUBTREE rollup, so summing them across parents and
  // children double-counts the child. Flagging the scope roots — in-scope
  // projects whose parent is not itself in scope — lets a caller total them
  // without re-deriving the hierarchy. The per-project rows stay subtree values,
  // which is what a per-project chart should plot.
  const parentById = new Map(
    subtreeLoad.allRows.map((row) => [row.id, row.parentProjectId]),
  );
  const inScope = new Set(ids);

  const costVsEstimate = ids.map((id) => {
    const subtree = subtreeRollups.get(id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP;
    let parent = parentById.get(id);
    let isScopeRoot = true;
    while (parent) {
      if (inScope.has(parent)) {
        isScopeRoot = false;
        break;
      }
      parent = parentById.get(parent);
    }
    return {
      projectId: shortcodeById.get(id)!,
      projectName: nameById.get(id) ?? "",
      actual: subtree.actualSpent,
      committed: subtree.committedSpent,
      estimate: subtree.costEstimate,
      isScopeRoot,
    };
  });

  const spendingByProject = ids
    .map((id) => ({
      projectId: shortcodeById.get(id)!,
      projectName: nameById.get(id) ?? "",
      spend: (subtreeRollups.get(id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP).spent,
    }))
    .sort((a, b) => b.spend - a.spend);

  // Project filters choose attribution shares; date filters then narrow the
  // source expenses. The full-purchase allocation denominator remains intact.
  const allocationScope = { projectIds: ids };
  const attributedCost = expenseAllocatedCostSql(
    sql`${expense.id}`,
    allocationScope,
  );
  const expenseScope = and(
    notDeleted(expense),
    expenseAllocationExistsSql(sql`${expense.id}`, allocationScope),
    filters.dateFrom ? sql`${expense.date} >= ${filters.dateFrom}` : undefined,
    filters.dateTo ? sql`${expense.date} <= ${filters.dateTo}` : undefined,
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
        ...aggregateForCost(attributedCost),
      })
      .from(expense)
      .where(expenseScopeWithDate)
      .groupBy(EXPENSE_MONTH_BUCKET)
      .orderBy(EXPENSE_MONTH_BUCKET),
    getDb(db)
      .select({
        month: sql<string>`${EXPENSE_MONTH_BUCKET}`,
        planned: sql<number>`coalesce(sum(${attributedCost}) filter (where ${expense.future} = true), 0)::float`,
        actual: sql<number>`coalesce(sum(${attributedCost}) filter (where ${expense.future} = false), 0)::float`,
      })
      .from(expense)
      .where(expenseScopeWithDate)
      .groupBy(EXPENSE_MONTH_BUCKET)
      .orderBy(EXPENSE_MONTH_BUCKET),
    getDb(db)
      .select({
        trade: effectiveExpenseTradeSql(),
        ...aggregateForCost(attributedCost),
      })
      .from(expense)
      .where(and(expenseScope, eq(expense.lineKind, "principal")))
      .groupBy(effectiveExpenseTradeSql()),
    getDb(db)
      .select(aggregateForCost(attributedCost))
      .from(expense)
      .where(and(expenseScope, ne(expense.lineKind, "principal"))),
    getDb(db)
      .select({
        projectId: effectiveTaskProjectSql("Task"),
        openTaskCount: sql<number>`count(*)::int`,
      })
      .from(task)
      .where(
        and(
          sql`${effectiveTaskProjectSql("Task")} = ANY(${uuidArrayParam(ids)})`,
          notDeleted(task),
          ne(task.status, "done"),
          isNull(task.parentTaskId),
        ),
      )
      .groupBy(effectiveTaskProjectSql("Task")),
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
