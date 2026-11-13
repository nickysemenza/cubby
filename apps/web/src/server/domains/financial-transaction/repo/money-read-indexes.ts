import { sql } from "drizzle-orm";

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

export const transactionCandidates = defineReadIndex(financialTransaction, {
  name: "transaction.accountAmount",
  values: (row) => [`${row.accountId}:${row.amount}`],
  where: (values) =>
    sql`EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(values.map((value) => ({ account: value.slice(0, 36), amount: value.slice(37) })))}::jsonb) candidate(account uuid, amount bigint) WHERE ${financialTransaction.accountId}=candidate.account AND ${financialTransaction.amount}=candidate.amount)`,
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
export const expenseAttributions = defineReadIndex(expenseAttribution, {
  name: "attribution.expense",
  values: (row) => [row.expenseId],
  where: (values) =>
    sql`${expenseAttribution.expenseId} = ANY(${columnArrayParam(values)})`,
});
export const vendorPurchases = defineReadIndex(purchase, {
  name: "purchase.vendor",
  values: (row) => (row.vendorId ? [row.vendorId] : []),
  where: (values) =>
    sql`${purchase.vendorId} = ANY(${columnArrayParam(values)})`,
});
export const amountPayments = defineReadIndex(purchasePaymentEvidence, {
  name: "payment.amount",
  values: (row) => [String(row.amountMinor)],
  where: (values) =>
    sql`${purchasePaymentEvidence.amountMinor} = ANY(${textArrayParam(values)}::bigint[])`,
});
export const purchasePayments = defineReadIndex(purchasePaymentEvidence, {
  name: "payment.purchase",
  values: (row) => [row.purchaseId],
  where: (values) =>
    sql`${purchasePaymentEvidence.purchaseId} = ANY(${columnArrayParam(values)})`,
});
export const vendorNames = defineReadIndex(vendor, {
  name: "vendor.name",
  values: (row) =>
    [row.name, ...row.aliases].map((name) => name.trim().toLowerCase()),
  where: (values) =>
    sql`EXISTS (SELECT 1 FROM unnest(ARRAY[${vendor.name}] || ${vendor.aliases}) name WHERE lower(trim(name)) = ANY(${textArrayParam(values)}))`,
});
