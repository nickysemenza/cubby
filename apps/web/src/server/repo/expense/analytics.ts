import type { CostType } from "@cubby/schemas/expense-fields";
/**
 * Expense analytics — server-side chart aggregates for the household
 * Expenses tracker (see packages/schemas/src/project.ts's
 * `expenseAnalyticsOut` doc comment). Replaces the client-side grouping that
 * used to run over `expense.chartData`'s fetch-all.
 *
 * Every breakdown shares ONE where-clause builder (`buildExpenseWhereClause`,
 * exported from `./lookup` — the same one `expenseList` uses) so ledger
 * totals (expense.list) and analytics totals (expense.analytics) can never
 * drift under the same filter set. Each breakdown is a single grouped SQL
 * aggregate — Postgres does the summing — run in parallel; never a
 * fetch-everything-then-group-in-JS pass.
 *
 * The aggregate column set (`actual`/`committed`/`credits`/`net`/`count`) and
 * the month-bucket expression are shared with `project/portfolio-analytics.ts`
 * — see `~/server/repo/expense-aggregate-sql` for the definitions and why
 * they live there instead of in either directory. Mirrors
 * project/analytics.ts's `projectRollups` split (`spent := sum(cost)` is the
 * same identity as this file's `net`).
 */
import {
  type ProjectShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type {
  ExpenseAnalyticsOut,
  ExpenseFilters,
  ExpenseMonthlySummaryOut,
  Trade,
} from "@cubby/schemas/project";
import { and, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import { alias, type SelectedFields } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { expense, project, purchase, vendor } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  EXPENSE_MONTH_BUCKET as MONTH_BUCKET,
  expenseAggregateFields,
  expenseShareAggregateFields,
} from "~/server/repo/expense-aggregate-sql";

import {
  executeExpenseDerivedBatch,
  prepareExpenseDerivedRead,
  type PreparedExpenseDerivedRead,
} from "../expense-derived-read";
import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
} from "../expense-inheritance";

const effectiveProjectId = effectiveExpenseProjectSql('"Expense"');
const effectiveTrade = effectiveExpenseTradeSql('"Expense"');

const summaryFields = (cost: SQL<number | null>) => ({
  ...expenseAggregateFields(cost),
  unpricedCount: sql<number>`count(*) filter (where ${cost} is null)::int`,
  actualCount: sql<number>`count(*) filter (where ${expense.future} = false)::int`,
  plannedCount: sql<number>`count(*) filter (where ${expense.future} = true)::int`,
});

/**
 * The charge table under its own alias, for `byVendor`'s join.
 *
 * See the ⚠️ note at the join itself: `buildExpenseWhereClause` already
 * sub-selects the unaliased `purchase` for the vendor/order filters, so the
 * join must not reuse that name.
 */
const chargeJoin = alias(purchase, "chargeJoin");

/** The monthly slice Home renders, without the other seven analytics queries. */
export async function expenseMonthlySummary(
  db: Database,
  filters: ExpenseFilters,
): Promise<ExpenseMonthlySummaryOut> {
  const read = await prepareExpenseDerivedRead(db, filters);
  const { where: whereClause } = read;
  const aggregate = read.aggregate;
  const datedWhereClause = and(whereClause, isNotNull(expense.date));
  return await read
    .select({ month: MONTH_BUCKET, ...aggregate })
    .where(datedWhereClause)
    .groupBy(MONTH_BUCKET)
    .orderBy(MONTH_BUCKET);
}

/**
 * Actual / committed / credits / net under a filter set: `expenseAnalytics`'s
 * `summary`, without its other eight queries. The project budget reads this so
 * its figures cannot drift from the analytics view's totals.
 */
export async function expenseSpendSummary(
  db: Database,
  filters: ExpenseFilters,
  prepared?: PreparedExpenseDerivedRead,
): Promise<ExpenseAnalyticsOut["summary"]> {
  const read = prepared ?? (await prepareExpenseDerivedRead(db, filters));
  const { where: whereClause } = read;
  const [summary] = await read
    .select(summaryFields(read.cost))
    .where(whereClause);
  // A GROUP-BY-less aggregate always returns exactly one row.
  return summary!;
}

export async function expenseAnalytics(
  db: Database,
  filters: ExpenseFilters,
  prepared?: PreparedExpenseDerivedRead,
): Promise<ExpenseAnalyticsOut> {
  const context = prepared ?? (await prepareExpenseDerivedRead(db, filters));
  const { where: whereClause } = context;
  // Null-date rows belong in lifetime totals, but have no month bucket.
  const datedWhereClause = and(whereClause, isNotNull(expense.date));
  const {
    summaryRows,
    byCostType,
    byTrade,
    tradeCostMatrix,
    monthly,
    byProjectResult,
    byVendor,
  } = await executeExpenseDerivedBatch(db, context, (read) => {
    const shareTrade = sql<Trade | null>`allocation.trade`;
    const shareCostType = sql<CostType>`allocation."costType"`;
    const shares = <K extends SelectedFields>(keys: K) =>
      getDb(db)
        .select({ ...keys, ...expenseShareAggregateFields() })
        .from(expense)
        .innerJoin(
          read.allocations,
          sql`allocation."expenseId" = ${expense.id}`,
        )
        .where(whereClause);
    return {
      summaryRows: read.select(summaryFields(read.cost)).where(whereClause),
      byCostType: shares({ costType: shareCostType }).groupBy(shareCostType),
      byTrade: shares({ trade: shareTrade }).groupBy(shareTrade),
      tradeCostMatrix: shares({
        trade: shareTrade,
        costType: shareCostType,
      }).groupBy(shareTrade, shareCostType),
      monthly: read
        .select({ month: MONTH_BUCKET, ...read.aggregate })
        .where(datedWhereClause)
        .groupBy(MONTH_BUCKET)
        .orderBy(MONTH_BUCKET),
      // Only live projects receive named buckets; unassigned shares remain
      // in the summary, preserving the visible attribution gap.
      byProjectResult: shares({
        projectShortcode: project.shortcode,
        projectName: project.name,
      })
        .innerJoin(
          project,
          and(sql`${project.id} = allocation."projectId"`, notDeleted(project)),
        )
        .groupBy(project.shortcode, project.name),
      // Use a separate Purchase alias because ledger vendor/order predicates
      // already select the unaliased Purchase table in their own scope.
      byVendor: read
        .select({
          vendorShortcode: vendor.shortcode,
          vendorName: vendor.name,
          ...read.aggregate,
        })
        .innerJoin(
          chargeJoin,
          and(eq(expense.purchaseId, chargeJoin.id), notDeleted(chargeJoin)),
        )
        .innerJoin(
          vendor,
          and(eq(chargeJoin.vendorId, vendor.id), notDeleted(vendor)),
        )
        .where(whereClause)
        .groupBy(vendor.shortcode, vendor.name),
    };
  });

  // A GROUP-BY-less aggregate always returns exactly one row, even over zero
  // matching expenses (every sum/count just comes back 0).
  const summary = summaryRows[0]!;

  // Cumulative net over time — a running sum of `monthly`'s already-computed
  // net (already sorted ascending by its own ORDER BY), not a second SQL
  // window-function query.
  monthly.sort((a, b) => a.month.localeCompare(b.month));
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
    byProject: byProjectResult.map(({ projectShortcode, ...row }) => ({
      ...row,
      projectId: parseShortcodeFor("project", projectShortcode),
    })),
    byVendor: byVendor.map(({ vendorShortcode, ...row }) => ({
      ...row,
      vendorId: parseShortcodeFor("vendor", vendorShortcode),
    })),
  };
}

/**
 * How often each project has been charged for each trade — the learned signal
 * behind the "which project does this expense belong to?" suggestion.
 *
 * Date overlap alone is far too coarse to rank on: concurrent sub-projects mean
 * the median unassigned expense sits inside ~9 live project windows. Weighting
 * those candidates by the project's existing same-trade expenses is what makes
 * the suggestion sharp — backtested over the already-linked ledger it picks the
 * correct project first 77% of the time, and within its top three 89%.
 *
 * One grouped aggregate over the whole ledger, not per-expense: the caller
 * ranks many rows against this single matrix rather than issuing a query each.
 * It stays small — projects x trades actually used, which is sparse.
 */
export async function expenseTradeAffinity(
  db: Database,
): Promise<{ projectId: ProjectShortcode; trade: Trade; count: number }[]> {
  const rows = await getDb(db)
    .select({
      projectShortcode: project.shortcode,
      trade: effectiveTrade,
      count: sql<number>`count(*)::int`,
    })
    .from(expense)
    .innerJoin(
      project,
      and(eq(effectiveProjectId, project.id), notDeleted(project)),
    )
    .where(
      and(
        notDeleted(expense),
        isNotNull(effectiveProjectId),
        isNotNull(effectiveTrade),
        eq(expense.lineKind, "principal"),
      ),
    )
    .groupBy(project.shortcode, effectiveTrade);

  return rows.flatMap((row) =>
    row.trade === null
      ? []
      : [
          {
            projectId: parseShortcodeFor("project", row.projectShortcode),
            trade: row.trade,
            count: row.count,
          },
        ],
  );
}
