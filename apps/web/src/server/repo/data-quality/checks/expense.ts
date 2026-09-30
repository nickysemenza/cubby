import { getTableName, sql } from "drizzle-orm";

import { expense } from "~/server/db/schema";
import {
  effectiveExpenseSpendingCategorySql,
  expenseProductExpectedSql,
} from "~/server/repo/purchase-evidence-policy";

import { defineEntityChecks } from "../registry";

type Expense = typeof expense;

export const expenseChecks = defineEntityChecks({
  entity: "expense",
  table: expense,
  checks: {
    expense_cost: {
      // A future (planned, not yet spent) line may be unpriced; once it is
      // no longer future a cost is expected.
      expected: (t: Expense) => sql`${t.future} = false`,
      missing: (t: Expense) => sql`${t.cost} IS NULL`,
      fingerprint: (t) => [sql`${t.future}`, sql`${t.cost}`],
    },
    expense_spending_category: {
      expected: (t) => sql`${t.future} = false`,
      missing: (t) =>
        sql`${effectiveExpenseSpendingCategorySql(getTableName(t))} IS NULL`,
      fingerprint: (t) => [
        effectiveExpenseSpendingCategorySql(getTableName(t)),
      ],
    },
    expense_product_resolution: {
      expected: (t) => expenseProductExpectedSql(getTableName(t)),
      missing: (t) => sql`${t.productId} IS NULL`,
      fingerprint: (t) => [
        expenseProductExpectedSql(getTableName(t)),
        sql`${t.productId}`,
      ],
    },
  },
});
