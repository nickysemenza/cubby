import type {
  ExpenseId,
  FinancialTransactionId,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  spendingCategorySummarySchema,
  type SpendingCategorySummary,
} from "@cubby/schemas/spending-classification";
import { and, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  expense,
  financialTransaction,
  financialTransactionAllocation,
  purchase,
} from "~/server/db/schema";

import { notDeleted, unwrapDb } from "./database-helpers";
import {
  loadExpenseSpendingAllocations,
  type ExpenseSpendingAllocationRow,
} from "./expense-spending-allocation";

export function emptySpendingCategorySummary(
  notApplicable = false,
): SpendingCategorySummary {
  return {
    state: notApplicable ? "not_applicable" : "unclassified",
    categories: [],
    lineCount: 0,
    categorizedLineCount: 0,
    uncategorizedLineCount: 0,
    complete: notApplicable,
    amountsKnown: false,
  };
}

function summaryState(
  categoryCount: number,
  uncategorizedLineCount: number,
): SpendingCategorySummary["state"] {
  if (!categoryCount) return "unclassified";
  if (uncategorizedLineCount > 0) return "partial";
  return categoryCount > 1 ? "mixed" : "single";
}

function summarize(
  lineIds: readonly ExpenseId[],
  allocations: Map<ExpenseId, ExpenseSpendingAllocationRow[]>,
  monetary: boolean,
): SpendingCategorySummary {
  const categories = new Map<
    string,
    SpendingCategorySummary["categories"][number]
  >();
  let categorizedLineCount = 0;
  let amountsKnown = monetary && lineIds.length > 0;
  for (const id of lineIds) {
    const rows = allocations.get(id) ?? [];
    if (
      rows.length &&
      rows.every(
        (row) =>
          row.spendingCategoryShortcode &&
          row.spendingCategoryName &&
          !row.incomplete,
      )
    )
      categorizedLineCount++;
    if (!rows.length || rows.some((row) => row.amount === null))
      amountsKnown = false;
    for (const row of rows) {
      if (!row.spendingCategoryShortcode || !row.spendingCategoryName) continue;
      const id = parseShortcodeFor(
        "spendingCategory",
        row.spendingCategoryShortcode,
      );
      const existing = categories.get(id);
      const amount =
        !monetary || row.amount === null || existing?.amount === null
          ? null
          : (Math.round((existing?.amount ?? 0) * 100) +
              Math.round(row.amount * 100)) /
            100;
      categories.set(id, { id, name: row.spendingCategoryName, amount });
    }
  }
  const uncategorizedLineCount = lineIds.length - categorizedLineCount;
  return spendingCategorySummarySchema.parse({
    state: summaryState(categories.size, uncategorizedLineCount),
    categories: [...categories.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
    lineCount: lineIds.length,
    categorizedLineCount,
    uncategorizedLineCount,
    complete: lineIds.length > 0 && uncategorizedLineCount === 0,
    amountsKnown,
  });
}

async function purchaseLines(
  db: Database | DrizzleTransaction,
  ids: readonly PurchaseId[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({ id: expense.id, purchaseId: expense.purchaseId })
    .from(expense)
    .innerJoin(purchase, eq(purchase.id, expense.purchaseId))
    .where(
      and(
        inArray(purchase.id, [...ids]),
        notDeleted(purchase),
        notDeleted(expense),
      ),
    );
}

export async function loadPurchaseSpendingCategorySummaries(
  db: Database | DrizzleTransaction,
  ids: readonly PurchaseId[],
): Promise<Map<PurchaseId, SpendingCategorySummary>> {
  const lines = await purchaseLines(db, ids);
  const allocations = lines.length
    ? await loadExpenseSpendingAllocations(
        db,
        lines.map((line) => line.id),
      )
    : new Map<ExpenseId, ExpenseSpendingAllocationRow[]>();
  return new Map(
    ids.map((id) => [
      id,
      summarize(
        lines.filter((line) => line.purchaseId === id).map((line) => line.id),
        allocations,
        true,
      ),
    ]),
  );
}

/** Purchase links identify context only: bank settlement amounts have no item/category attribution. */
export async function loadTransactionSpendingCategorySummaries(
  db: Database | DrizzleTransaction,
  ids: readonly FinancialTransactionId[],
): Promise<Map<FinancialTransactionId, SpendingCategorySummary>> {
  if (!ids.length) return new Map();
  const database = unwrapDb(db);
  const [transactions, links] = await Promise.all([
    database
      .select({
        id: financialTransaction.id,
        kind: financialTransaction.kind,
        status: financialTransaction.status,
        ledgerTransferId: financialTransaction.ledgerTransferId,
      })
      .from(financialTransaction)
      .where(
        and(
          inArray(financialTransaction.id, [...ids]),
          notDeleted(financialTransaction),
        ),
      ),
    database
      .select({
        transactionId: financialTransactionAllocation.transactionId,
        purchaseId: purchase.id,
      })
      .from(financialTransactionAllocation)
      .innerJoin(
        purchase,
        eq(purchase.id, financialTransactionAllocation.purchaseId),
      )
      .where(
        and(
          inArray(financialTransactionAllocation.transactionId, [...ids]),
          notDeleted(financialTransactionAllocation),
          notDeleted(purchase),
        ),
      ),
  ]);
  const lines = await purchaseLines(db, [
    ...new Set(links.map((link) => link.purchaseId)),
  ]);
  const allocations = lines.length
    ? await loadExpenseSpendingAllocations(
        db,
        lines.map((line) => line.id),
      )
    : new Map<ExpenseId, ExpenseSpendingAllocationRow[]>();
  return new Map(
    transactions.map((transaction) => {
      if (
        transaction.status === "void" ||
        transaction.ledgerTransferId ||
        transaction.kind === "account_transfer" ||
        transaction.kind === "credit_card_payment"
      )
        return [transaction.id, emptySpendingCategorySummary(true)];
      const purchaseIds = new Set(
        links
          .filter((link) => link.transactionId === transaction.id)
          .map((link) => link.purchaseId),
      );
      const lineIds = [
        ...new Set(
          lines
            .filter(
              (line) => line.purchaseId && purchaseIds.has(line.purchaseId),
            )
            .map((line) => line.id),
        ),
      ];
      return [transaction.id, summarize(lineIds, allocations, false)];
    }),
  );
}
