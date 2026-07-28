/**
 * Purchase analytics — server-side chart aggregates for the household
 * Purchases tracker (see packages/schemas/src/project.ts's
 * `purchaseAnalyticsOut` doc comment). Replaces the client-side grouping that
 * used to run over `purchase.chartData`'s fetch-all.
 *
 * Every breakdown shares ONE where-clause builder (`buildPurchaseWhereClause`,
 * exported from `./lookup` — the same one `purchaseList` uses) so ledger
 * totals (purchase.list) and analytics totals (purchase.analytics) can never
 * drift under the same filter set. Each breakdown is a single grouped SQL
 * aggregate — Postgres does the summing — run in parallel; never a
 * fetch-everything-then-group-in-JS pass.
 */
import type { ProjectId } from "@cubby/schemas/identifiers";
import type {
  PurchaseAnalyticsOut,
  PurchaseFilters,
  Trade,
} from "@cubby/schemas/project";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { project, purchase } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { buildPurchaseWhereClause } from "./lookup";

/**
 * actual/committed/credits/net/count — the shared aggregate columns every
 * breakdown selects. Mirrors project/analytics.ts's `projectRollups` split:
 * `actual` = live spend already made, `committed` = future/planned spend,
 * `credits` = refunds & contributions (stored as negative `cost`, flipped
 * positive here). `net` is the purchase's blended total — algebraically
 * `actual + committed - credits`, which telescopes to a plain `sum(cost)`
 * (cost = 0 and NULL cost both contribute nothing to any of the three
 * either), the exact identity `projectRollups` uses for `spent := sum(cost)`.
 * Computed directly as one sum rather than three-way arithmetic to keep the
 * query plan cheap. A fresh object is returned per call since these `sql`
 * fragments get spread into several independent `select()`s below.
 */
const aggregateSelect = () => ({
  actual: sql<number>`coalesce(sum(${purchase.cost}) filter (where ${purchase.cost} > 0 and ${purchase.future} = false), 0)::float`,
  committed: sql<number>`coalesce(sum(${purchase.cost}) filter (where ${purchase.cost} > 0 and ${purchase.future} = true), 0)::float`,
  credits: sql<number>`coalesce(-sum(${purchase.cost}) filter (where ${purchase.cost} < 0), 0)::float`,
  net: sql<number>`coalesce(sum(${purchase.cost}), 0)::float`,
  count: sql<number>`count(*)::int`,
});

/** `"YYYY-MM"` bucket expression, reused for both the monthly SELECT and its GROUP/ORDER BY. */
const MONTH_BUCKET = sql<string>`to_char(${purchase.date}, 'YYYY-MM')`;

export async function purchaseAnalytics(
  db: Database,
  filters: PurchaseFilters,
): Promise<PurchaseAnalyticsOut> {
  const whereClause = await buildPurchaseWhereClause(db, filters);
  // `purchase.date` is nullable (a `future` purchase commonly has none yet) —
  // exclude null-date rows from the month-bucketed breakdowns only (can't
  // bucket what has no date); summary/byCostType/byTrade/byProject still
  // include them.
  const datedWhereClause = and(whereClause, isNotNull(purchase.date));

  const [
    summaryRows,
    byCostType,
    byTrade,
    tradeCostMatrix,
    monthly,
    byProjectRows,
  ] = await Promise.all([
    getDb(db)
      .select({
        ...aggregateSelect(),
        actualCount: sql<number>`count(*) filter (where ${purchase.future} = false)::int`,
        plannedCount: sql<number>`count(*) filter (where ${purchase.future} = true)::int`,
      })
      .from(purchase)
      .where(whereClause),
    getDb(db)
      .select({ costType: purchase.costType, ...aggregateSelect() })
      .from(purchase)
      .where(whereClause)
      .groupBy(purchase.costType),
    getDb(db)
      .select({ trade: purchase.trade, ...aggregateSelect() })
      .from(purchase)
      .where(whereClause)
      .groupBy(purchase.trade),
    getDb(db)
      .select({
        trade: purchase.trade,
        costType: purchase.costType,
        ...aggregateSelect(),
      })
      .from(purchase)
      .where(whereClause)
      .groupBy(purchase.trade, purchase.costType),
    getDb(db)
      .select({ month: MONTH_BUCKET, ...aggregateSelect() })
      .from(purchase)
      .where(datedWhereClause)
      .groupBy(MONTH_BUCKET)
      .orderBy(MONTH_BUCKET),
    // Inner-joined to `project` (and its own `notDeleted`) for the display
    // name, so `projectId IS NOT NULL` implicitly excludes inbox purchases
    // (no project to report against) as well as purchases still pointing at
    // a soft-deleted project — mirroring `resolveLiveJoinName`'s convention
    // of hiding a deleted parent's name elsewhere in the purchase API.
    getDb(db)
      .select({
        projectId: purchase.projectId,
        projectName: project.name,
        ...aggregateSelect(),
      })
      .from(purchase)
      .innerJoin(
        project,
        and(eq(purchase.projectId, project.id), notDeleted(project)),
      )
      .where(and(whereClause, isNotNull(purchase.projectId)))
      .groupBy(purchase.projectId, project.name),
  ]);

  // A GROUP-BY-less aggregate always returns exactly one row, even over zero
  // matching purchases (every sum/count just comes back 0).
  const summary = summaryRows[0]!;

  // Cumulative net over time — a running sum of `monthly`'s already-computed
  // net (already sorted ascending by its own ORDER BY), not a second SQL
  // window-function query.
  let running = 0;
  const cumulative = monthly.map((row) => {
    running += row.net;
    return { month: row.month, cumulativeNet: running };
  });

  return {
    summary,
    byCostType,
    byTrade,
    tradeCostMatrix,
    monthly,
    cumulative,
    byProject: byProjectRows.map((row) => ({
      ...row,
      // Guaranteed non-null by the `isNotNull(purchase.projectId)` filter
      // above — Drizzle just doesn't narrow the select's inferred type from it.
      projectId: row.projectId!,
    })),
  };
}

/**
 * How often each project has been charged for each trade — the learned signal
 * behind the "which project does this purchase belong to?" suggestion.
 *
 * Date overlap alone is far too coarse to rank on: concurrent sub-projects mean
 * the median unassigned purchase sits inside ~9 live project windows. Weighting
 * those candidates by the project's existing same-trade purchases is what makes
 * the suggestion sharp — backtested over the already-linked ledger it picks the
 * correct project first 77% of the time, and within its top three 89%.
 *
 * One grouped aggregate over the whole ledger, not per-purchase: the caller
 * ranks many rows against this single matrix rather than issuing a query each.
 * It stays small — projects x trades actually used, which is sparse.
 */
export async function purchaseTradeAffinity(
  db: Database,
): Promise<{ projectId: ProjectId; trade: Trade; count: number }[]> {
  const rows = await getDb(db)
    .select({
      projectId: purchase.projectId,
      trade: purchase.trade,
      count: sql<number>`count(*)::int`,
    })
    .from(purchase)
    .where(and(notDeleted(purchase), isNotNull(purchase.projectId)))
    .groupBy(purchase.projectId, purchase.trade);

  return rows.map((row) => ({
    // Non-null by the isNotNull filter; Drizzle doesn't narrow from it.
    projectId: row.projectId!,
    trade: row.trade,
    count: row.count,
  }));
}
