import { sql, type SQL } from "drizzle-orm";

import {
  columnArrayParam,
  textArrayParam,
} from "~/server/db/helpers/array-param";
import {
  financialTransaction,
  sourceOccurrence,
  financialTransactionAllocation,
  expense,
  expenseAttribution,
  purchase,
  purchasePaymentEvidence,
  vendor,
} from "~/server/db/schema";
import { defineReadIndex } from "~/server/kernel/api";

/** One lookup value per transaction: its absolute amount and effective day. */
export const amountDayValue = (amount: bigint, date: string) =>
  `${amount < 0n ? -amount : amount}:${date}`;

/**
 * Matches `FinancialTransaction_amount_day_idx`. Day numbers keep the indexed
 * expression immutable; a date's text output depends on the session DateStyle.
 */
const amountDay = sql`(abs(${financialTransaction.amount})::text || ':' || (coalesce(${financialTransaction.transactionDate}, ${financialTransaction.postedDate}) - DATE '1970-01-01')::text)`;

export const transactionCandidates = defineReadIndex(financialTransaction, {
  name: "transaction.amountDay",
  values: (row) =>
    (row.transactionDate ?? row.postedDate)
      ? [amountDayValue(row.amount, (row.transactionDate ?? row.postedDate)!)]
      : [],
  where: (values) =>
    sql`${amountDay} = ANY(${textArrayParam(
      values.map((value) => {
        const split = value.indexOf(":");
        return `${value.slice(0, split)}:${Date.parse(`${value.slice(split + 1)}T00:00:00Z`) / 86_400_000}`;
      }),
    )})`,
});
/** One lookup value per transaction: its signed amount on any day. */
export const transactionAmounts = defineReadIndex(financialTransaction, {
  name: "transaction.amount",
  values: (row) => [String(row.amount)],
  where: (values) =>
    sql`${financialTransaction.amount} = ANY(${textArrayParam(values)}::bigint[])`,
});
/** The legs a LedgerTransfer links. */
export const transferLegs = defineReadIndex(financialTransaction, {
  name: "transaction.transfer",
  values: (row) => (row.ledgerTransferId ? [row.ledgerTransferId] : []),
  where: (values) =>
    sql`${financialTransaction.ledgerTransferId} = ANY(${columnArrayParam(values)})`,
});
/** Matches `Expense_bookingTransactionCode_idx`; deleted lines included. */
export const bookingExpenses = defineReadIndex(expense, {
  name: "expense.bookingTransaction",
  values: (row) =>
    row.bookingTransactionCode ? [row.bookingTransactionCode] : [],
  where: (values) =>
    sql`${expense.bookingTransactionCode} = ANY(${textArrayParam(values)})`,
});
export const acceptedOccurrences = defineReadIndex(sourceOccurrence, {
  name: "occurrence.transaction",
  values: (row) =>
    row.acceptedTransactionId ? [row.acceptedTransactionId] : [],
  where: (values) =>
    sql`${sourceOccurrence.acceptedTransactionId} = ANY(${columnArrayParam(values)})`,
});
export const transactionAllocations = defineReadIndex(
  financialTransactionAllocation,
  {
    name: "allocation.transaction",
    values: (row) => [row.transactionId],
    where: (values) =>
      sql`${financialTransactionAllocation.transactionId} = ANY(${columnArrayParam(values)})`,
  },
);
export const purchaseAllocations = defineReadIndex(
  financialTransactionAllocation,
  {
    name: "allocation.purchase",
    values: (row) => [row.purchaseId],
    where: (values) =>
      sql`${financialTransactionAllocation.purchaseId} = ANY(${columnArrayParam(values)})`,
  },
);
export const purchaseExpenses = defineReadIndex(expense, {
  name: "expense.purchase",
  values: (row) => (row.purchaseId ? [row.purchaseId] : []),
  where: (values) =>
    sql`${expense.purchaseId} = ANY(${columnArrayParam(values)})`,
});
export const unlinkedProductExpenses = defineReadIndex(expense, {
  name: "expense.unlinkedProduct",
  values: (row) =>
    !row.deletedAt && !row.purchaseId && row.productId ? [row.productId] : [],
  where: (values) =>
    sql`${expense.productId} = ANY(${columnArrayParam(values)}) AND ${expense.purchaseId} IS NULL AND ${expense.deletedAt} IS NULL`,
});
export const expenseAttributions = defineReadIndex(expenseAttribution, {
  name: "attribution.expense",
  values: (row) => [row.expenseId],
  where: (values) =>
    sql`${expenseAttribution.expenseId} = ANY(${columnArrayParam(values)})`,
});
export const vendorPurchases = defineReadIndex(purchase, {
  name: "purchase.vendorDate",
  values: (row) =>
    row.vendorId && row.date ? [`${row.vendorId}:${row.date}`] : [],
  where: (values) =>
    sql`EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(values.map((value) => ({ vendor: value.slice(0, 36), date: value.slice(37) })))}::jsonb) candidate(vendor uuid,date text) WHERE ${purchase.vendorId}=candidate.vendor AND ${purchase.date}::text=candidate.date)`,
});
export const amountPayments = defineReadIndex(purchasePaymentEvidence, {
  name: "payment.amount",
  values: (row) => [String(row.amountMinor)],
  where: (values) =>
    sql`${purchasePaymentEvidence.amountMinor} = ANY(${textArrayParam(values)}::bigint[])`,
});
export const purchasePayments = defineReadIndex(purchasePaymentEvidence, {
  name: "payment.purchase",
  values: (row) => (row.purchaseId ? [row.purchaseId] : []),
  where: (values) =>
    sql`${purchasePaymentEvidence.purchaseId} = ANY(${columnArrayParam(values)})`,
});
export const orderPayments = defineReadIndex(purchasePaymentEvidence, {
  name: "payment.orderObservation",
  values: (row) => (row.orderObservationId ? [row.orderObservationId] : []),
  where: (values) =>
    sql`${purchasePaymentEvidence.orderObservationId} = ANY(${columnArrayParam(values)})`,
});
export const vendorNames = defineReadIndex(vendor, {
  name: "vendor.name",
  values: (row) =>
    [row.name, ...row.aliases].map((name) => name.trim().toLowerCase()),
  where: (values) =>
    sql`EXISTS (SELECT 1 FROM unnest(ARRAY[${vendor.name}] || ${vendor.aliases}) name WHERE lower(trim(name)) = ANY(${textArrayParam(values)}))`,
});
/**
 * A merchant or Vendor name as payment matching compares it: the six ASCII
 * whitespace characters (space, tab, line feed, vertical tab, form feed,
 * carriage return) trimmed and each run collapsed to one space, and only A-Z
 * lower-cased. PostgreSQL evaluates the same patterns, passed as parameters,
 * and the same letter map, so every string has one key on both sides.
 */
const MERCHANT_EDGES = "^[ \\t\\n\\v\\f\\r]+|[ \\t\\n\\v\\f\\r]+$";
const MERCHANT_RUNS = "[ \\t\\n\\v\\f\\r]+";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const edges = new RegExp(MERCHANT_EDGES, "gu");
const runs = new RegExp(MERCHANT_RUNS, "gu");
export const merchantKey = (name: string) =>
  name
    .replace(edges, "")
    .replace(runs, " ")
    .replace(/[A-Z]/gu, (letter) => LOWER[UPPER.indexOf(letter)]!);
/** The SQL spelling of {@link merchantKey}. */
const merchantKeySql = (name: SQL) =>
  sql`translate(regexp_replace(regexp_replace(${name}, ${MERCHANT_EDGES}, '', 'g'), ${MERCHANT_RUNS}, ' ', 'g'), ${UPPER}, ${LOWER})`;
/** Vendor names and aliases by merchant key; an empty key is never stored or read. */
export const vendorMerchants = defineReadIndex(vendor, {
  name: "vendor.merchant",
  values: (row) =>
    [...new Set([row.name, ...row.aliases].map(merchantKey))].filter(Boolean),
  where: (values) =>
    sql`EXISTS (SELECT 1 FROM unnest(array_prepend(${vendor.name}, ${vendor.aliases})) alias
      WHERE ${merchantKeySql(sql`alias`)} = ANY(${textArrayParam(values)}))`,
});
