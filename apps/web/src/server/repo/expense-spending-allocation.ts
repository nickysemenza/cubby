import type { ExpenseId, SpendingCategoryId } from "@cubby/schemas/identifiers";
import { sql, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/repo/database-helpers";

import type { ExpenseSpendingCategoryResolutionDraft } from "./expense-category-resolution";
import {
  expenseJointAllocationSql,
  type ExpenseProjectAllocationBasis,
} from "./expense-project-allocation";

export type ExpenseSpendingAllocationRow = {
  spendingCategoryId: SpendingCategoryId | null;
  spendingCategoryShortcode: string | null;
  spendingCategoryName: string | null;
  amount: number | null;
  basis: ExpenseProjectAllocationBasis;
  incomplete: boolean;
};

type RawSpendingAllocationRow = ExpenseSpendingAllocationRow & {
  expenseId: ExpenseId;
};

/** Unknown shares remain in the breakdown and never acquire a guessed category. */
export const expenseSpendingAllocationSql = (
  expenseIds?: readonly ExpenseId[] | SQL,
  draft?: ExpenseSpendingCategoryResolutionDraft,
): SQL => sql`
  SELECT a."expenseId", a."spendingCategoryId", a."spendingCategoryShortcode", a."spendingCategoryName",
    (sum(a."attributedCents"::bigint) / 100.0)::double precision AS amount,
    a.basis, bool_or(a."categoryIncomplete") AS incomplete
  FROM (${expenseJointAllocationSql(expenseIds, draft)}) a
  GROUP BY a."expenseId", a."spendingCategoryId", a."spendingCategoryShortcode", a."spendingCategoryName", a.basis
  ORDER BY a."expenseId", a."spendingCategoryId" NULLS LAST
`;

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
