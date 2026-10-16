import type { CostType } from "@cubby/schemas/expense-fields";
import type { ExpenseId, SpendingCategoryId } from "@cubby/schemas/identifiers";
import type { Trade } from "@cubby/schemas/project";
import type { SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import type { ExpenseSpendingCategoryResolutionDraft } from "~/server/domains/expense/repo/expense-category-resolution";

import { expenseDerivedReadSql } from "./expense-derived-read";
import type {
  ExpenseIdSelection,
  ExpenseProjectAllocationBasis,
} from "./expense-project-allocation";

export type ExpenseSpendingAllocationRow = {
  spendingCategoryId: SpendingCategoryId | null;
  spendingCategoryShortcode: string | null;
  spendingCategoryName: string | null;
  amount: number | null;
  basis: ExpenseProjectAllocationBasis;
  incomplete: boolean;
  /** Distinct trades and cost types among this category's shares. */
  trades: Trade[];
  costTypes: CostType[];
};

type RawSpendingAllocationRow = ExpenseSpendingAllocationRow & {
  expenseId: ExpenseId;
};

/** Unknown shares remain in the breakdown and never acquire a guessed category. */
export const expenseSpendingAllocationSql = (
  expenseIds?: ExpenseIdSelection,
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL => expenseDerivedReadSql("categories", { expenseIds, draft });

export async function loadExpenseSpendingAllocations(
  db: Database | DrizzleTransaction,
  expenseIds?: readonly ExpenseId[],
  draft?: ExpenseSpendingCategoryResolutionDraft,
): Promise<Map<ExpenseId, ExpenseSpendingAllocationRow[]>> {
  const result = await unwrapDb(db).execute<RawSpendingAllocationRow>(
    expenseSpendingAllocationSql(expenseIds, draft),
  );
  const byExpense = new Map<ExpenseId, ExpenseSpendingAllocationRow[]>();
  for (const { expenseId, ...allocation } of result.rows) {
    const rows = byExpense.get(expenseId) ?? [];
    rows.push(allocation);
    byExpense.set(expenseId, rows);
  }
  return byExpense;
}
