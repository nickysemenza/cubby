/**
 * `project.portfolioAnalytics` — the chart aggregates that used to ride
 * along in `project.dashboard`'s full task/purchase arrays (client-side
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
 *   - it additionally bounds `purchase.date` directly for the purchase-grouped
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
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import { project, purchase, task } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  PURCHASE_MONTH_BUCKET,
  purchaseAggregateFields,
} from "~/server/repo/purchase-aggregate-sql";
import { projectRollups } from "./analytics";
import { buildDashboardProjectWhere } from "./dashboard-shared";
import { EMPTY_PROJECT_SUBTREE_ROLLUP } from "./helpers";
import {
  aggregateSubtreeRollups,
  allProjectParentRows,
  buildChildrenMap,
  collectDescendantIds,
} from "./subtree";

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
  const allRows = await allProjectParentRows(db);
  const childrenByParent = buildChildrenMap(allRows);

  const projectRows = await getDb(db).query.project.findMany({
    where: buildDashboardProjectWhere(filters),
    orderBy: [asc(project.name)],
    columns: { id: true, name: true },
  });
  const ids = projectRows.map((r) => r.id);
  if (ids.length === 0) return EMPTY_OUT;

  const nameById = new Map(projectRows.map((r) => [r.id, r.name]));
  const descendantIds = ids.flatMap((id) =>
    collectDescendantIds(childrenByParent, id),
  );

  const ownRollups = await projectRollups(db, uniq([...ids, ...descendantIds]));
  const subtreeRollups = aggregateSubtreeRollups(allRows, ownRollups);

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

  // Purchase-based aggregates: purchases whose OWN projectId is in the
  // filtered set (not subtree-expanded — a sub-project's own purchases only
  // count here if the sub-project itself matched the filter; unlike
  // costVsEstimate/spendingByProject, which intentionally show subtree
  // totals). Inbox purchases (no project) are excluded — judgment call, see
  // the task report.
  const purchaseScope = and(
    inArray(purchase.projectId, ids),
    notDeleted(purchase),
    filters.dateFrom ? gte(purchase.date, filters.dateFrom) : undefined,
    filters.dateTo ? lte(purchase.date, filters.dateTo) : undefined,
  );
  const purchaseScopeWithDate = and(purchaseScope, isNotNull(purchase.date));

  const [monthlyRows, plannedVsActualRows, tradeRows, taskHeatmapRows] =
    await Promise.all([
      getDb(db)
        .select({
          month: sql<string>`${PURCHASE_MONTH_BUCKET}`,
          ...purchaseAggregateFields(),
        })
        .from(purchase)
        .where(purchaseScopeWithDate)
        .groupBy(PURCHASE_MONTH_BUCKET)
        .orderBy(PURCHASE_MONTH_BUCKET),
      getDb(db)
        .select({
          month: sql<string>`${PURCHASE_MONTH_BUCKET}`,
          planned: sql<number>`coalesce(sum(${purchase.cost}) filter (where ${purchase.future} = true), 0)::float`,
          actual: sql<number>`coalesce(sum(${purchase.cost}) filter (where ${purchase.future} = false), 0)::float`,
        })
        .from(purchase)
        .where(purchaseScopeWithDate)
        .groupBy(PURCHASE_MONTH_BUCKET)
        .orderBy(PURCHASE_MONTH_BUCKET),
      getDb(db)
        .select({ trade: purchase.trade, ...purchaseAggregateFields() })
        .from(purchase)
        .where(purchaseScope)
        .groupBy(purchase.trade),
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
