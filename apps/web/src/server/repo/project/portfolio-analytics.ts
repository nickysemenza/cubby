/**
 * `project.portfolioAnalytics` — the chart aggregates that used to ride
 * along in `project.dashboard`'s full task/purchase arrays (client-side
 * reduced by projects-dashboard.tsx), now computed server-side and loaded
 * only when the Charts/Analytics tab is selected. Scoped by the same
 * `statusScope`/`kinds`/`locations`/`search` filters as `dashboardSummary`
 * (see `dashboard-shared.ts`), plus `dateFrom`/`dateTo` bounding the
 * purchase-based aggregates (`monthlySpend`/`plannedVsActual`/`tradeActivity`)
 * — `costVsEstimate`/`spendingByProject` stay LIFETIME totals (they reuse the
 * same subtree rollup shown on project cards, which has no date axis) and
 * `taskHeatmap` has no purchase date to bound against either.
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

/** Shared actual/committed/credits/net/count SQL, matching `purchaseAggregateFields`. */
const purchaseAggregateSelect = {
  actual: sql<number>`coalesce(sum(${purchase.cost}) filter (where ${purchase.cost} > 0 and ${purchase.future} = false), 0)::float`,
  committed: sql<number>`coalesce(sum(${purchase.cost}) filter (where ${purchase.cost} > 0 and ${purchase.future} = true), 0)::float`,
  credits: sql<number>`coalesce(-sum(${purchase.cost}) filter (where ${purchase.cost} < 0), 0)::float`,
  net: sql<number>`coalesce(sum(${purchase.cost}), 0)::float`,
  count: sql<number>`count(*)::int`,
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
  const monthExpr = sql`to_char(${purchase.date}, 'YYYY-MM')`;

  const [monthlyRows, plannedVsActualRows, tradeRows, taskHeatmapRows] =
    await Promise.all([
      getDb(db)
        .select({
          month: sql<string>`${monthExpr}`,
          ...purchaseAggregateSelect,
        })
        .from(purchase)
        .where(purchaseScopeWithDate)
        .groupBy(monthExpr)
        .orderBy(monthExpr),
      getDb(db)
        .select({
          month: sql<string>`${monthExpr}`,
          planned: sql<number>`coalesce(sum(${purchase.cost}) filter (where ${purchase.future} = true), 0)::float`,
          actual: sql<number>`coalesce(sum(${purchase.cost}) filter (where ${purchase.future} = false), 0)::float`,
        })
        .from(purchase)
        .where(purchaseScopeWithDate)
        .groupBy(monthExpr)
        .orderBy(monthExpr),
      getDb(db)
        .select({ trade: purchase.trade, ...purchaseAggregateSelect })
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
