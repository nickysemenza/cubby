import {
  CASH_FLOW_IRREGULAR_KEY,
  type CashFlowBaselineRow,
  type CashFlowEnvelope,
  type CashFlowMonth,
  type CashFlowProjectionArgs,
  type CashFlowProjectionOut,
  type CashFlowScenario,
  type CashFlowUnscheduled,
} from "@cubby/schemas/cash-flow";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import { type ProjectId, projectShortcode } from "@cubby/schemas/identifiers";
import {
  HOUSEHOLD_PROJECT_SHORTCODE,
  type ProjectStatus,
} from "@cubby/schemas/project";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { householdLocalDate, shiftPlainDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { expense, project, spendingCategory } from "~/server/db/schema";
import { prepareExpenseDerivedRead } from "~/server/domains/expense/repo/expense-derived-read";
import {
  rootSpendingCategoryBucketFilter,
  rootSpendingCategoryJoins,
  rootSpendingCategoryKeySql,
  rootSpendingCategoryLabelSql,
} from "~/server/domains/expense/repo/spending-category-root";
import { loadProjectSubtreeRollups } from "~/server/domains/project/repo/subtree";
import { createAppError } from "~/server/errors/app-error";

const BASELINE_MONTHS = 12;
/** A category with spend in fewer of the 12 months than this is Irregular. */
const IRREGULAR_BELOW_ACTIVE_MONTHS = 3;

const monthIndex = (month: string): number => {
  const [year = 0, mon = 1] = month.split("-").map(Number);
  return year * 12 + (mon - 1);
};

/** "YYYY-MM" shifted by whole months. */
const shiftMonth = (month: string, months: number): string => {
  const index = monthIndex(month) + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
};
const monthOf = (plainDate: string) => plainDate.slice(0, 7);
const dollars = (cents: number) => cents / 100;
const cents = (amount: number) => Math.round(amount * 100);

/** A Ledger search with only its set params. */
const definedEntries = (
  params: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/** Median of whole-cent values, the middle pair rounded to a whole cent. */
const medianCents = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
};

/** Split `total` cents evenly over `count` months, extra cents first. */
const spreadCents = (total: number, count: number): number[] => {
  const base = Math.floor(total / count);
  const extra = total - base * count;
  return Array.from({ length: count }, (_, index) =>
    index < extra ? base + 1 : base,
  );
};

const scenarioMonths = (
  scenario: CashFlowScenario,
  first: string,
  last: string,
): string[] => {
  const start = monthOf(scenario.date);
  if (scenario.recurrence === "once")
    return start >= first && start <= last ? [start] : [];
  const end = scenario.until ? monthOf(scenario.until) : last;
  const months: string[] = [];
  for (
    let month = start < first ? first : start;
    month <= end && month <= last;
    month = shiftMonth(month, 1)
  )
    months.push(month);
  return months;
};

type BaselineShare = {
  month: string;
  key: string;
  label: string;
  cents: string;
};

/**
 * Landed spend over the trailing complete months, per month and root
 * Spending Category bucket, from the joint allocator's shares. A share counts
 * when it has no live project or sits on the standing Household project;
 * spend on any other project is that project's envelope instead.
 */
async function loadBaselineShares(
  db: Database,
  window: { from: string; to: string },
): Promise<BaselineShare[]> {
  const read = await prepareExpenseDerivedRead(db, {
    dateFrom: window.from,
    dateTo: window.to,
    future: false,
  });
  const shareProject = alias(project, "cashFlowShareProject");
  const { roots, root } = rootSpendingCategoryJoins;
  const monthSql = sql<string>`to_char(${expense.date}, 'YYYY-MM')`;
  return unwrapDb(db)
    .select({
      month: monthSql,
      key: rootSpendingCategoryKeySql,
      label: rootSpendingCategoryLabelSql,
      cents: sql<string>`sum(allocation."attributedCents"::bigint)::text`,
    })
    .from(expense)
    .innerJoin(read.allocations, sql`allocation."expenseId" = ${expense.id}`)
    .leftJoin(
      shareProject,
      and(
        sql`${shareProject.id} = allocation."projectId"`,
        notDeleted(shareProject),
      ),
    )
    .leftJoin(roots.table, roots.on)
    .leftJoin(root.table, root.on)
    .where(
      and(
        read.where,
        sql`allocation."attributedCents" IS NOT NULL`,
        sql`(${shareProject.id} IS NULL OR ${shareProject.shortcode} = ${HOUSEHOLD_PROJECT_SHORTCODE})`,
      ),
    )
    .groupBy(
      monthSql,
      rootSpendingCategoryKeySql,
      rootSpendingCategoryLabelSql,
    );
}

/** Committed (`future`) Expenses by date; their dates are never null. */
const loadCommitted = (db: Database) =>
  unwrapDb(db)
    .select({
      date: sql<string>`${expense.date}::text`,
      cents: sql<string>`round(sum(${expense.cost})::numeric * 100)::bigint::text`,
    })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        eq(expense.future, true),
        sql`${expense.cost} IS NOT NULL`,
      ),
    )
    .groupBy(expense.date);

async function assertRootCategories(db: Database, codes: readonly string[]) {
  const live = await unwrapDb(db)
    .select({ shortcode: spendingCategory.shortcode })
    .from(spendingCategory)
    .where(
      and(
        inArray(spendingCategory.shortcode, [...codes]),
        isNull(spendingCategory.parentId),
        notDeleted(spendingCategory),
      ),
    );
  const found = new Set(live.map((row) => row.shortcode));
  const missing = codes.filter((code) => !found.has(code));
  if (missing.length > 0)
    throw createAppError(
      "SPENDING_CATEGORY_NOT_FOUND",
      `Not a live root Spending Category: ${missing.join(", ")}. categoryIds takes root categories only.`,
    );
}

const COUNTED_STATUSES = new Set<ProjectStatus>([
  "in_progress",
  "not_started",
  "planning",
]);

/**
 * Forward monthly cash flow, computed on read ("Cash flow" in
 * docs/household-finance-analytics.md). `today` exists for tests; the
 * operation always passes the household's current day.
 */
export async function cashFlowProjection(
  db: Database,
  input: CashFlowProjectionArgs,
  today: string = householdLocalDate(),
): Promise<CashFlowProjectionOut> {
  const currentMonth = monthOf(today);
  const firstMonth = currentMonth;
  const lastMonth = shiftMonth(currentMonth, input.horizonMonths - 1);
  const horizon = Array.from({ length: input.horizonMonths }, (_, index) =>
    shiftMonth(currentMonth, index),
  );
  const windowMonths = Array.from({ length: BASELINE_MONTHS }, (_, index) =>
    shiftMonth(currentMonth, index - BASELINE_MONTHS),
  );
  const baselineWindow = {
    from: `${windowMonths[0]}-01`,
    to: shiftPlainDate(`${currentMonth}-01`, -1),
  };
  if (input.categoryIds?.length)
    await assertRootCategories(db, input.categoryIds);

  const [shares, committedRows, tree] = await Promise.all([
    loadBaselineShares(db, baselineWindow),
    loadCommitted(db),
    loadProjectSubtreeRollups(db),
  ]);

  // Baseline: per bucket, 12 monthly net figures with empty months as 0.
  const buckets = new Map<
    string,
    { label: string; byMonth: Map<string, number> }
  >();
  const narrowed = input.categoryIds
    ? new Set<string>(input.categoryIds)
    : null;
  for (const share of shares) {
    if (narrowed && !narrowed.has(share.key)) continue;
    const bucket = buckets.get(share.key) ?? {
      label: share.label,
      byMonth: new Map(),
    };
    bucket.byMonth.set(
      share.month,
      (bucket.byMonth.get(share.month) ?? 0) + Number(share.cents),
    );
    buckets.set(share.key, bucket);
  }
  const categoryRows = [...buckets.entries()].map(([key, bucket]) => {
    const series = windowMonths.map((month) => bucket.byMonth.get(month) ?? 0);
    const activeMonths = series.filter((value) => value !== 0).length;
    const totalCents = series.reduce((sum, value) => sum + value, 0);
    const irregular = activeMonths < IRREGULAR_BELOW_ACTIVE_MONTHS;
    // A sparse series' median is almost always 0, so an Irregular category
    // carries its mean (trailing total ÷ 12). Grouped and separate modes both
    // sum these same whole-cent figures, so they reconcile exactly.
    const monthlyCents = irregular
      ? Math.round(totalCents / BASELINE_MONTHS)
      : medianCents(series);
    return {
      key,
      label: bucket.label,
      irregular,
      activeMonths,
      totalCents,
      monthlyCents,
    };
  });
  categoryRows.sort(
    (a, b) => b.monthlyCents - a.monthlyCents || a.label.localeCompare(b.label),
  );
  const toRow = (row: (typeof categoryRows)[number]): CashFlowBaselineRow => ({
    key: row.key,
    label: row.label,
    irregular: row.irregular,
    activeMonths: row.activeMonths,
    trailingTotal: dollars(row.totalCents),
    monthly: dollars(row.monthlyCents),
    ledgerFilter: {
      ...definedEntries(rootSpendingCategoryBucketFilter(row.key)),
      dateFrom: baselineWindow.from,
      dateTo: baselineWindow.to,
      future: "false",
      project: `${FILTER_NONE},${HOUSEHOLD_PROJECT_SHORTCODE}`,
      includeSubProjects: "false",
    },
  });
  const irregularRows = categoryRows.filter((row) => row.irregular);
  const baselineRows: CashFlowBaselineRow[] =
    input.irregular === "separate" || irregularRows.length === 0
      ? categoryRows.map(toRow)
      : [
          ...categoryRows.filter((row) => !row.irregular).map(toRow),
          {
            key: CASH_FLOW_IRREGULAR_KEY,
            label: "Irregular",
            irregular: true,
            activeMonths: new Set(
              irregularRows.flatMap((row) =>
                windowMonths.filter(
                  (month) =>
                    (buckets.get(row.key)?.byMonth.get(month) ?? 0) !== 0,
                ),
              ),
            ).size,
            trailingTotal: dollars(
              irregularRows.reduce((sum, row) => sum + row.totalCents, 0),
            ),
            monthly: dollars(
              irregularRows.reduce((sum, row) => sum + row.monthlyCents, 0),
            ),
            ledgerFilter: null,
          },
        ];
  const baselineMonthlyCents = categoryRows.reduce(
    (sum, row) => sum + row.monthlyCents,
    0,
  );

  // Envelopes (decisions 15–16).
  const { allRows, rowsById, subtreeRollups, dateWindows } = tree;
  const hasEstimatedAncestor = (parentId: ProjectId | null): boolean => {
    const seen = new Set<ProjectId>();
    for (let current = parentId; current !== null && !seen.has(current);) {
      seen.add(current);
      const parent = rowsById.get(current);
      if (!parent) return false;
      if (parent.costEstimate !== null) return true;
      current = parent.parentProjectId;
    }
    return false;
  };
  const envelopes: CashFlowEnvelope[] = [];
  const unscheduled: CashFlowUnscheduled[] = [];
  const envelopeCents = new Map<string, Map<string, number>>();
  let beyondHorizonCents = 0;
  for (const row of allRows) {
    if (row.shortcode === HOUSEHOLD_PROJECT_SHORTCODE) continue;
    if (!COUNTED_STATUSES.has(row.status)) continue;
    if (row.status === "not_started" && !input.includeNotStarted) continue;
    if (row.costEstimate === null || row.costEstimate <= 0) continue;
    if (hasEstimatedAncestor(row.parentProjectId)) continue;
    const subtree = subtreeRollups.get(row.id);
    const actual = subtree?.actualSpent ?? 0;
    const committed = subtree?.committedSpent ?? 0;
    // Net spend (decision 15): `spent` already includes committed and nets
    // credits, so a refund restores the envelope.
    const remainingCents = Math.max(
      0,
      cents(row.costEstimate) - cents(subtree?.spent ?? 0),
    );
    const endDate = dateWindows.get(row.id)?.effectiveEnd ?? null;
    const base = {
      id: projectShortcode.parse(row.shortcode),
      name: row.name,
      status: row.status,
      estimate: row.costEstimate,
      actual,
      committed,
      remaining: dollars(remainingCents),
      endDate,
    };
    if (endDate === null || endDate <= today) {
      unscheduled.push(base);
      continue;
    }
    const months = Array.from(
      { length: monthIndex(monthOf(endDate)) - monthIndex(currentMonth) + 1 },
      (_, index) => shiftMonth(currentMonth, index),
    );
    const parts = spreadCents(remainingCents, months.length);
    const byMonth = new Map<string, number>();
    let beyond = 0;
    months.forEach((month, index) => {
      const part = parts[index] ?? 0;
      if (month <= lastMonth) byMonth.set(month, part);
      else beyond += part;
    });
    beyondHorizonCents += beyond;
    envelopeCents.set(row.shortcode, byMonth);
    envelopes.push({ ...base, beyondHorizon: dollars(beyond) });
  }

  // Committed: own month; before the current month lands now as overdue.
  const committedByMonth = new Map<
    string,
    { total: number; overdue: number }
  >();
  let committedBeyondCents = 0;
  for (const row of committedRows) {
    const amount = Number(row.cents);
    const month = monthOf(row.date);
    if (month > lastMonth) {
      committedBeyondCents += amount;
      continue;
    }
    const target = month < currentMonth ? currentMonth : month;
    const entry = committedByMonth.get(target) ?? { total: 0, overdue: 0 };
    entry.total += amount;
    if (month < currentMonth) entry.overdue += amount;
    committedByMonth.set(target, entry);
  }

  const scenarioCents = new Map<string, { inflow: number; outflow: number }>();
  for (const scenario of input.scenarios) {
    for (const month of scenarioMonths(scenario, firstMonth, lastMonth)) {
      const entry = scenarioCents.get(month) ?? { inflow: 0, outflow: 0 };
      entry[scenario.direction] += cents(scenario.amount);
      scenarioCents.set(month, entry);
    }
  }

  let horizonOutflowCents = 0;
  let horizonInflowCents = 0;
  const months: CashFlowMonth[] = horizon.map((month) => {
    const monthEnvelopes = envelopes
      .map((envelope) => ({
        id: envelope.id,
        cents: envelopeCents.get(envelope.id)?.get(month) ?? 0,
      }))
      .filter((entry) => entry.cents !== 0);
    const envelopeTotal = monthEnvelopes.reduce((sum, e) => sum + e.cents, 0);
    const committed = committedByMonth.get(month) ?? { total: 0, overdue: 0 };
    const scenario = scenarioCents.get(month) ?? { inflow: 0, outflow: 0 };
    const outflow =
      baselineMonthlyCents + envelopeTotal + committed.total + scenario.outflow;
    horizonOutflowCents += outflow;
    horizonInflowCents += scenario.inflow;
    return {
      month,
      baseline: baselineRows.map((row) => ({
        key: row.key,
        amount: row.monthly,
      })),
      envelopes: monthEnvelopes.map((entry) => ({
        id: entry.id,
        amount: dollars(entry.cents),
      })),
      committed: dollars(committed.total),
      committedOverdue: dollars(committed.overdue),
      scenarioOutflow: dollars(scenario.outflow),
      scenarioInflow: dollars(scenario.inflow),
      outflow: dollars(outflow),
      net: dollars(scenario.inflow - outflow),
    };
  });

  return {
    currentMonth,
    baselineWindow,
    irregular: input.irregular,
    baseline: baselineRows,
    envelopes,
    months,
    unscheduled,
    totals: {
      baselineMonthly: dollars(baselineMonthlyCents),
      horizonOutflow: dollars(horizonOutflowCents),
      horizonInflow: dollars(horizonInflowCents),
      unscheduledTotal: dollars(
        unscheduled.reduce((sum, row) => sum + cents(row.remaining), 0),
      ),
      beyondHorizon: dollars(beyondHorizonCents),
      committedBeyondHorizon: dollars(committedBeyondCents),
      netAfterScenarios: dollars(horizonInflowCents - horizonOutflowCents),
    },
  };
}
