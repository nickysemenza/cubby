import { RECONCILIATION_TOLERANCE } from "@cubby/schemas/purchase";
import { getTableName, sql } from "drizzle-orm";

import { purchase } from "~/server/db/schema";
import {
  postedRefundTotalSql,
  purchaseFinancialComparisonTotalSql,
  purchaseFinancialMismatchRawSql,
  settleableExpenseTotalSql,
  settleableUnpricedExpenseCountSql,
  settlementReferenceAbsentSql,
  vendorExpenseTotalSql,
  vendorExpenseCountSql,
  vendorUnpricedExpenseCountSql,
} from "~/server/repo/financial-reconciliation";
import { cents } from "~/server/repo/money";
import {
  purchaseEvidenceExpectationSql,
  purchaseEvidenceFingerprintSql,
  purchaseHasItemizationSql,
  purchaseHasPrimaryDocumentSql,
} from "~/server/repo/purchase-evidence-policy";

import { defineEntityChecks } from "../registry";

type Purchase = typeof purchase;

/** The quoted alias the reconciliation raw-SQL helpers correlate on. */
const aliasOf = (t: Purchase) => `"${getTableName(t)}"`;

const expectation = (t: Purchase) =>
  purchaseEvidenceExpectationSql(getTableName(t));
const expectsDocument = (t: Purchase) => sql`(${expectation(t)} = 'required')`;
const hasPrimaryDocument = (t: Purchase) =>
  purchaseHasPrimaryDocumentSql(getTableName(t));
const hasItemization = (t: Purchase) =>
  purchaseHasItemizationSql(getTableName(t));
const expectsOrderId = (t: Purchase) => sql`EXISTS (
  SELECT 1 FROM "ImportSourceOrder" dq_order
  JOIN "ImportSourceClaim" dq_order_source ON dq_order_source.id = dq_order."sourceClaimId"
  WHERE dq_order."purchaseId" = ${t.id} AND dq_order_source.kind = 'browser_order'
)`;

const hasExpenses = (t: Purchase) => sql`EXISTS (
  SELECT 1 FROM "Expense" dq_e
  WHERE dq_e."purchaseId" = ${t.id} AND dq_e."deletedAt" IS NULL
)`;

const expenseCount = (t: Purchase) => sql`(
  SELECT count(*)::int FROM "Expense" dq_e
  WHERE dq_e."purchaseId" = ${t.id} AND dq_e."deletedAt" IS NULL
)`;

// A future (planned, not yet spent) line may be unpriced, as `expense_cost`
// already allows on the line itself.
const unpricedExpenseCount = (t: Purchase) => sql`(
  SELECT count(*)::int FROM "Expense" dq_e
  WHERE dq_e."purchaseId" = ${t.id} AND dq_e."deletedAt" IS NULL AND dq_e."cost" IS NULL
    AND dq_e."future" = false
)`;

const expenseCents = (t: Purchase) =>
  sql`floor((${sql.raw(vendorExpenseTotalSql(aliasOf(t)))} * 100)::numeric + 0.5)`;
const vendorExpenseCount = (t: Purchase) =>
  sql.raw(vendorExpenseCountSql(aliasOf(t)));
const vendorUnpricedExpenseCount = (t: Purchase) =>
  sql.raw(vendorUnpricedExpenseCountSql(aliasOf(t)));

const moneyCents = (value: ReturnType<typeof sql>) =>
  sql`CASE WHEN ${value} IS NULL THEN NULL ELSE floor((${value} * 100)::numeric + 0.5) END`;

const statedCents = (t: Purchase) => moneyCents(sql`${t.statedTotal}`);
const refundCents = (t: Purchase) =>
  moneyCents(sql.raw(postedRefundTotalSql(aliasOf(t))));

const tolerance = sql.raw(String(cents(RECONCILIATION_TOLERANCE)));

/**
 * Mirrors `reconcilePurchase`: stated total present, at least one line (a
 * lineless purchase is `empty_expenses`, not a mismatch — without this the
 * `dataGap=` filter disagreed with the hydrated object it filters), the
 * delta beyond tolerance, and posted refunds not fully explaining it.
 */
const paperworkMismatch = (t: Purchase) => {
  const delta = sql`(${expenseCents(t)} - floor((${t.statedTotal} * 100)::numeric + 0.5))`;
  const fullyPriced = sql`${vendorUnpricedExpenseCount(t)} = 0`;
  const refundAdjusted = sql`(${fullyPriced} AND ${delta} < ${sql.raw(`-${cents(RECONCILIATION_TOLERANCE)}`)}
    AND floor((${sql.raw(postedRefundTotalSql(aliasOf(t)))} * 100)::numeric + 0.5) = ${delta})`;
  return sql`(${t.statedTotal} IS NOT NULL
    AND ${vendorExpenseCount(t)} > 0
    AND abs(${delta}) > ${tolerance}
    AND NOT ${refundAdjusted})`;
};

export const purchaseChecks = defineEntityChecks({
  entity: "purchase",
  table: purchase,
  related: {
    product: (t, productId) => sql`EXISTS (
      SELECT 1 FROM "Expense" dq_pe
      WHERE dq_pe."purchaseId" = ${t.id}
        AND dq_pe."productId" = ${productId}
        AND dq_pe."deletedAt" IS NULL
    )`,
  },
  checks: {
    purchase_date: {
      missing: (t) => sql`${t.date} IS NULL`,
      fingerprint: (t) => [sql`${t.date}`],
    },
    order_id: {
      // A statement booking or orderless receipt has no vendor order identity
      // to invent. Browser-order provenance establishes that one was expected.
      expected: expectsOrderId,
      missing: (t) => sql`${t.orderId} IS NULL`,
      fingerprint: (t) => [expectsOrderId(t), sql`${t.orderId}`],
    },
    stated_total: {
      expected: hasPrimaryDocument,
      missing: (t) => sql`${t.statedTotal} IS NULL`,
      fingerprint: (t) => [hasPrimaryDocument(t), statedCents(t)],
    },
    primary_document: {
      expected: expectsDocument,
      missing: (t) => sql`NOT ${hasPrimaryDocument(t)}`,
      fingerprint: (t) => [expectsDocument(t), hasPrimaryDocument(t)],
    },
    empty_expenses: {
      missing: (t) => sql`NOT ${hasExpenses(t)}`,
      fingerprint: (t) => [expenseCount(t)],
    },
    purchase_spending_category_origin: {
      expected: (t) => sql`${t.spendingCategoryId} IS NOT NULL`,
      missing: (t) => sql`${t.spendingCategoryOrigin} = 'legacy'`,
      fingerprint: (t) => [
        sql`${t.spendingCategoryId}`,
        sql`${t.spendingCategoryOrigin}`,
      ],
    },
    purchase_evidence_expectation: {
      missing: (t) => sql`${expectation(t)} = 'unknown'`,
      fingerprint: (t) => [expectation(t)],
    },
    purchase_itemization: {
      expected: expectsDocument,
      missing: (t) => sql`NOT ${hasItemization(t)}`,
      fingerprint: (t) => [
        purchaseEvidenceFingerprintSql(getTableName(t)),
        hasItemization(t),
      ],
    },
    unpriced_expense: {
      missing: (t) => sql`${unpricedExpenseCount(t)} > 0`,
      fingerprint: (t) => [unpricedExpenseCount(t)],
    },
    paperwork_mismatch: {
      missing: paperworkMismatch,
      fingerprint: (t) => [
        statedCents(t),
        expenseCents(t),
        vendorExpenseCount(t),
        vendorUnpricedExpenseCount(t),
        refundCents(t),
      ],
    },
    settlement_reference: {
      missing: (t) => sql.raw(settlementReferenceAbsentSql(aliasOf(t))),
      fingerprint: (t) => [
        sql`NOT (${sql.raw(settlementReferenceAbsentSql(aliasOf(t)))})`,
      ],
    },
    settlement_mismatch: {
      // Settlement evidence and the expense ledger can both be correct while
      // a source leaves a small residual; the raw verdict stays a financial
      // fact and only a reasoned exception removes it from the worklist.
      missing: (t) =>
        sql`(${sql.raw(purchaseFinancialMismatchRawSql(aliasOf(t)))})`,
      // Same inputs, in the same order, as the stored fingerprints written by
      // `purchaseFinancialMismatchFingerprintRawSql`.
      fingerprint: (t) => [
        sql`(${sql.raw(purchaseFinancialMismatchRawSql(aliasOf(t)))})`,
        sql.raw(purchaseFinancialComparisonTotalSql(aliasOf(t))),
        sql.raw(settleableExpenseTotalSql(aliasOf(t))),
        sql.raw(settleableUnpricedExpenseCountSql(aliasOf(t))),
      ],
    },
  },
});
