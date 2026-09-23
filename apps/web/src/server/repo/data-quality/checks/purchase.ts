import {
  primaryPurchaseDocumentKinds,
  RECONCILIATION_TOLERANCE,
} from "@cubby/schemas/purchase";
import { getTableName, sql } from "drizzle-orm";

import { purchase } from "~/server/db/schema";
import {
  postedRefundTotalSql,
  purchaseFinancialComparisonTotalSql,
  purchaseFinancialMismatchRawSql,
  settleableExpenseTotalSql,
  settleableUnpricedExpenseCountSql,
  settlementReferenceAbsentSql,
} from "~/server/repo/financial-reconciliation";

import { defineEntityChecks } from "../registry";

type Purchase = typeof purchase;

/** The quoted alias the reconciliation raw-SQL helpers correlate on. */
const aliasOf = (t: Purchase) => `"${getTableName(t)}"`;

const orderEvidence = (t: Purchase) => sql`(
  SELECT v."orderEvidence" FROM "Vendor" v
  WHERE v."id" = ${t.vendorId} AND v."deletedAt" IS NULL
)`;

/**
 * The two import-driven checks apply only when the vendor can supply them:
 * `online_account` expects a document and lines, `receipt_only` a document,
 * `not_expected` neither. An unclassified vendor (`null`) expects both so it
 * stays visible until explicitly classified.
 */
const expectsDocument = (t: Purchase) =>
  sql`(${orderEvidence(t)} IS NULL OR ${orderEvidence(t)} IN ('online_account', 'receipt_only'))`;
const expectsExpenses = (t: Purchase) =>
  sql`(${orderEvidence(t)} IS NULL OR ${orderEvidence(t)} = 'online_account')`;

const primaryDocumentKinds = sql.raw(
  primaryPurchaseDocumentKinds.map((kind) => `'${kind}'`).join(", "),
);

const hasPrimaryDocument = (t: Purchase) => sql`EXISTS (
  SELECT 1 FROM "EntityAttachment" dq_pi
  JOIN "Image" dq_i ON dq_i."id" = dq_pi."imageId" AND dq_i."deletedAt" IS NULL
  WHERE dq_pi."subjectEntityId" = ${t.id} AND dq_pi."deletedAt" IS NULL
    AND dq_pi."documentKind" IN (${primaryDocumentKinds})
)`;

const hasExpenses = (t: Purchase) => sql`EXISTS (
  SELECT 1 FROM "Expense" dq_e
  WHERE dq_e."purchaseId" = ${t.id} AND dq_e."deletedAt" IS NULL
)`;

const expenseCount = (t: Purchase) => sql`(
  SELECT count(*)::int FROM "Expense" dq_e
  WHERE dq_e."purchaseId" = ${t.id} AND dq_e."deletedAt" IS NULL
)`;

const unpricedExpenseCount = (t: Purchase) => sql`(
  SELECT count(*)::int FROM "Expense" dq_e
  WHERE dq_e."purchaseId" = ${t.id} AND dq_e."deletedAt" IS NULL AND dq_e."cost" IS NULL
)`;

const expenseCents = (t: Purchase) => sql`floor((COALESCE((
  SELECT sum(dq_e."cost") FROM "Expense" dq_e
  WHERE dq_e."purchaseId" = ${t.id} AND dq_e."deletedAt" IS NULL
), 0) * 100)::numeric + 0.5)`;

const moneyCents = (value: ReturnType<typeof sql>) =>
  sql`CASE WHEN ${value} IS NULL THEN NULL ELSE floor((${value} * 100)::numeric + 0.5) END`;

const statedCents = (t: Purchase) => moneyCents(sql`${t.statedTotal}`);
const refundCents = (t: Purchase) =>
  moneyCents(sql.raw(postedRefundTotalSql(aliasOf(t))));

const tolerance = sql.raw(String(Math.round(RECONCILIATION_TOLERANCE * 100)));

/**
 * Mirrors `reconcilePurchase`: stated total present, at least one line (a
 * lineless purchase is `empty_expenses`, not a mismatch — without this the
 * `dataGap=` filter disagreed with the hydrated object it filters), the
 * delta beyond tolerance, and posted refunds not fully explaining it.
 */
const paperworkMismatch = (t: Purchase) => {
  const delta = sql`(${expenseCents(t)} - floor((${t.statedTotal} * 100)::numeric + 0.5))`;
  const fullyPriced = sql`NOT EXISTS (
    SELECT 1 FROM "Expense" dq_unpriced
    WHERE dq_unpriced."purchaseId" = ${t.id}
      AND dq_unpriced."cost" IS NULL AND dq_unpriced."deletedAt" IS NULL
  )`;
  const refundAdjusted = sql`(${fullyPriced} AND ${delta} < ${sql.raw(`-${Math.round(RECONCILIATION_TOLERANCE * 100)}`)}
    AND floor((${sql.raw(postedRefundTotalSql(aliasOf(t)))} * 100)::numeric + 0.5) = ${delta})`;
  return sql`(${t.statedTotal} IS NOT NULL
    AND ${hasExpenses(t)}
    AND abs(${delta}) > ${tolerance}
    AND NOT ${refundAdjusted})`;
};

export const purchaseChecks = defineEntityChecks({
  entity: "purchase",
  table: purchase,
  exceptions: (t) => t.dataExceptions,
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
      missing: (t) => sql`${t.orderId} IS NULL`,
      fingerprint: (t) => [sql`${t.orderId}`],
    },
    stated_total: {
      missing: (t) => sql`${t.statedTotal} IS NULL`,
      fingerprint: (t) => [statedCents(t)],
    },
    primary_document: {
      expected: expectsDocument,
      missing: (t) => sql`NOT ${hasPrimaryDocument(t)}`,
      fingerprint: (t) => [expectsDocument(t), hasPrimaryDocument(t)],
    },
    empty_expenses: {
      expected: expectsExpenses,
      missing: (t) => sql`NOT ${hasExpenses(t)}`,
      fingerprint: (t) => [expectsExpenses(t), expenseCount(t)],
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
        expenseCount(t),
        unpricedExpenseCount(t),
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
