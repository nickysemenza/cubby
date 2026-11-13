import { sql } from "drizzle-orm";

import { textArrayParam } from "~/server/db/helpers/array-param";
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

export const transactionCandidates = defineReadIndex(financialTransaction, {
  name: "transaction.accountAmount",
  values: (row) => [`${row.accountId}:${row.amount}`],
  where: (values) =>
    sql`(${financialTransaction.accountId}::text || ':' || ${financialTransaction.amount}::text) = ANY(${textArrayParam(values)})`,
});
export const acceptedOccurrences = defineReadIndex(sourceOccurrence, {
  name: "occurrence.transaction",
  values: (row) =>
    row.acceptedTransactionId ? [row.acceptedTransactionId] : [],
  where: (values) =>
    sql`${sourceOccurrence.acceptedTransactionId}::text = ANY(${textArrayParam(values)})`,
});
export const transactionAllocations = defineReadIndex(
  financialTransactionAllocation,
  {
    name: "allocation.transaction",
    values: (row) => [row.transactionId],
    where: (values) =>
      sql`${financialTransactionAllocation.transactionId}::text = ANY(${textArrayParam(values)})`,
  },
);
export const purchaseAllocations = defineReadIndex(
  financialTransactionAllocation,
  {
    name: "allocation.purchase",
    values: (row) => [row.purchaseId],
    where: (values) =>
      sql`${financialTransactionAllocation.purchaseId}::text = ANY(${textArrayParam(values)})`,
  },
);
export const purchaseExpenses = defineReadIndex(expense, {
  name: "expense.purchase",
  values: (row) => (row.purchaseId ? [row.purchaseId] : []),
  where: (values) =>
    sql`${expense.purchaseId}::text = ANY(${textArrayParam(values)})`,
});
export const expenseAttributions = defineReadIndex(expenseAttribution, {
  name: "attribution.expense",
  values: (row) => [row.expenseId],
  where: (values) =>
    sql`${expenseAttribution.expenseId}::text = ANY(${textArrayParam(values)})`,
});
export const vendorPurchases = defineReadIndex(purchase, {
  name: "purchase.vendor",
  values: (row) => (row.vendorId ? [row.vendorId] : []),
  where: (values) =>
    sql`${purchase.vendorId}::text = ANY(${textArrayParam(values)})`,
});
export const amountPayments = defineReadIndex(purchasePaymentEvidence, {
  name: "payment.amount",
  values: (row) => [String(row.amountMinor)],
  where: (values) =>
    sql`${purchasePaymentEvidence.amountMinor}::text = ANY(${textArrayParam(values)})`,
});
export const purchasePayments = defineReadIndex(purchasePaymentEvidence, {
  name: "payment.purchase",
  values: (row) => [row.purchaseId],
  where: (values) =>
    sql`${purchasePaymentEvidence.purchaseId}::text = ANY(${textArrayParam(values)})`,
});
export const vendorNames = defineReadIndex(vendor, {
  name: "vendor.name",
  values: (row) =>
    [row.name, ...row.aliases].map((name) => name.trim().toLowerCase()),
  where: (values) =>
    sql`EXISTS (SELECT 1 FROM unnest(ARRAY[${vendor.name}] || ${vendor.aliases}) name WHERE lower(trim(name)) = ANY(${textArrayParam(values)}))`,
});
