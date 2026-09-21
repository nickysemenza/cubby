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
import { and, eq, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { expense, project, purchase, vendor } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { EXPENSE_MONTH_BUCKET as MONTH_BUCKET } from "~/server/repo/expense-aggregate-sql";

import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
} from "../expense-inheritance";
import {
  expenseAllocatedCostSql,
  expenseAllocationScopeConditionSql,
  expenseProjectAllocationSql,
  type ExpenseAllocationProjectScope,
} from "../expense-project-allocation";
import {
  buildExpenseWhereClause,
  resolveExpenseProjectAllocationScope,
} from "./lookup";

const effectiveProjectId = effectiveExpenseProjectSql('"Expense"');
const effectiveTrade = effectiveExpenseTradeSql('"Expense"');

const aggregateForCost = (cost: SQL<number | null>) => ({
  actual: sql<number>`coalesce(sum(${cost}) filter (where ${cost} > 0 and ${expense.future} = false), 0)::float`,
  committed: sql<number>`coalesce(sum(${cost}) filter (where ${cost} > 0 and ${expense.future} = true), 0)::float`,
  credits: sql<number>`coalesce(-sum(${cost}) filter (where ${cost} < 0), 0)::float`,
  net: sql<number>`coalesce(sum(${cost}), 0)::float`,
  count: sql<number>`count(*)::int`,
});

const analyticsCost = (scope: ExpenseAllocationProjectScope | undefined) =>
  scope
    ? expenseAllocatedCostSql(sql`${expense.id}`, scope)
    : sql<number | null>`${expense.cost}`;

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
  const whereClause = await buildExpenseWhereClause(db, filters);
  const projectScope = await resolveExpenseProjectAllocationScope(db, filters);
  const aggregate = aggregateForCost(analyticsCost(projectScope));
  const datedWhereClause = and(whereClause, isNotNull(expense.date));
  return await getDb(db)
    .select({ month: MONTH_BUCKET, ...aggregate })
    .from(expense)
    .where(datedWhereClause)
    .groupBy(MONTH_BUCKET)
    .orderBy(MONTH_BUCKET);
}

export async function expenseAnalytics(
  db: Database,
  filters: ExpenseFilters,
): Promise<ExpenseAnalyticsOut> {
  const whereClause = await buildExpenseWhereClause(db, filters);
  const projectScope = await resolveExpenseProjectAllocationScope(db, filters);
  const aggregate = aggregateForCost(analyticsCost(projectScope));
  const principalWhereClause = and(
    whereClause,
    eq(expense.lineKind, "principal"),
  );
  const adjustmentsWhereClause = and(
    whereClause,
    ne(expense.lineKind, "principal"),
  );
  // `expense.date` is nullable (a `future` expense commonly has none yet) —
  // exclude null-date rows from the month-bucketed breakdowns only (can't
  // bucket what has no date); summary/byCostType/byTrade/byProject still
  // include them.
  const datedWhereClause = and(whereClause, isNotNull(expense.date));

  const [
    summaryRows,
    adjustmentRows,
    byCostType,
    byTrade,
    tradeCostMatrix,
    monthly,
    byProjectResult,
    byVendor,
  ] = await Promise.all([
    getDb(db)
      .select({
        ...aggregate,
        actualCount: sql<number>`count(*) filter (where ${expense.future} = false)::int`,
        plannedCount: sql<number>`count(*) filter (where ${expense.future} = true)::int`,
      })
      .from(expense)
      .where(whereClause),
    getDb(db)
      .select({ ...aggregate })
      .from(expense)
      .where(adjustmentsWhereClause),
    getDb(db)
      .select({ costType: expense.costType, ...aggregate })
      .from(expense)
      .where(principalWhereClause)
      .groupBy(expense.costType),
    getDb(db)
      .select({ trade: effectiveTrade, ...aggregate })
      .from(expense)
      .where(principalWhereClause)
      .groupBy(effectiveTrade),
    getDb(db)
      .select({
        trade: effectiveTrade,
        costType: expense.costType,
        ...aggregate,
      })
      .from(expense)
      .where(principalWhereClause)
      .groupBy(effectiveTrade, expense.costType),
    getDb(db)
      .select({ month: MONTH_BUCKET, ...aggregate })
      .from(expense)
      .where(datedWhereClause)
      .groupBy(MONTH_BUCKET)
      .orderBy(MONTH_BUCKET),
    // Inner-joined to `project` (and its own `notDeleted`) for the display
    // name, so `projectId IS NOT NULL` implicitly excludes inbox expenses
    // (no project to report against) as well as expenses still pointing at
    // a soft-deleted project — mirroring `resolveLiveJoinName`'s convention
    // of hiding a deleted parent's name elsewhere in the expense API.
    getDb(db).execute<{
      projectShortcode: string;
      projectName: string;
      actual: number;
      committed: number;
      credits: number;
      net: number;
      count: number;
    }>(sql`
      SELECT
        p."shortcode" AS "projectShortcode",
        p."name" AS "projectName",
        coalesce(sum((allocation."attributedCents"::bigint / 100.0))
          filter (where allocation."attributedCents"::bigint > 0 and ${expense.future} = false), 0)::float8 AS actual,
        coalesce(sum((allocation."attributedCents"::bigint / 100.0))
          filter (where allocation."attributedCents"::bigint > 0 and ${expense.future} = true), 0)::float8 AS committed,
        coalesce(-sum((allocation."attributedCents"::bigint / 100.0))
          filter (where allocation."attributedCents"::bigint < 0), 0)::float8 AS credits,
        coalesce(sum(allocation."attributedCents"::bigint) / 100.0, 0)::float8 AS net,
        count(DISTINCT ${expense.id})::int AS count
      FROM (${expenseProjectAllocationSql()}) allocation
      JOIN ${expense} ON ${expense.id} = allocation."expenseId"
      JOIN ${project} p ON p."id" = allocation."projectId" AND p."deletedAt" IS NULL
      WHERE ${whereClause ?? sql`true`}
        ${
          projectScope
            ? sql`AND ${expenseAllocationScopeConditionSql("allocation", projectScope) ?? sql`true`}`
            : sql``
        }
      GROUP BY p."shortcode", p."name"
    `),
    // Spend by the vendor the money went to, resolved through the charge:
    // expense → Purchase → Vendor. Inner-joined for the same reason `byProject`
    // is, with the same consequence: charge-less rows (no vendor recorded) are
    // excluded, so this does NOT sum to `summary.net`. That gap is the size of
    // the unattributed tail and is worth reading, not papering over with a left
    // join that would invent an "unknown vendor" bucket.
    //
    // `notDeleted` on BOTH joins: a soft-deleted charge is still a row, so
    // without it an expense whose charge was deleted would keep reporting under
    // its old vendor — the same guard `resolveExpenseSort`'s vendor subquery
    // applies on read.
    //
    // ⚠️ The charge table is ALIASED, deliberately. `buildExpenseWhereClause`
    // emits `inArray(expense.purchaseId, <SELECT purchase.id …>)` whenever
    // `vendorId`/`orderId`/`orderIdPresenceFilter` is set, which puts the
    // unaliased `purchase` inside this query's WHERE. Joining the same table
    // unaliased in the FROM as well would place it in two scopes at once —
    // Postgres resolves that today, but it's implicit coupling that breaks
    // quietly later. `byProject` never hit this: nothing in the where clause
    // sub-selects `project`.
    getDb(db)
      .select({
        vendorShortcode: vendor.shortcode,
        vendorName: vendor.name,
        ...aggregate,
      })
      .from(expense)
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
  ]);

  // A GROUP-BY-less aggregate always returns exactly one row, even over zero
  // matching expenses (every sum/count just comes back 0).
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
    adjustments: adjustmentRows[0]!,
    byCostType,
    byTrade: byTrade.filter(
      (row): row is typeof row & { trade: Trade } => row.trade !== null,
    ),
    tradeCostMatrix: tradeCostMatrix.filter(
      (row): row is typeof row & { trade: Trade } => row.trade !== null,
    ),
    monthly,
    cumulative,
    byProject: byProjectResult.rows.map(({ projectShortcode, ...row }) => ({
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
