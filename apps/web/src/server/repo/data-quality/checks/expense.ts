import { sql, type SQL } from "drizzle-orm";

import { expense } from "~/server/db/schema";
import {
  effectiveExpenseSpendingCategorySql,
  expenseProductExpectedSql,
} from "~/server/repo/purchase-evidence-policy";

import { defineEntityChecks } from "../registry";

type Expense = typeof expense;

// Relational lists rename Expense to expense. Keep the outer reference as a
// Drizzle column and evaluate policy under an alias local to this subquery.
const policyProjection = (
  t: Expense,
  policy: (alias: string) => SQL,
): SQL => sql`(
  SELECT ${policy("dq_expense_policy")} FROM "Expense" dq_expense_policy
  WHERE dq_expense_policy.id = ${t.id}
)`;

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
        sql`${policyProjection(t, effectiveExpenseSpendingCategorySql)} IS NULL`,
      fingerprint: (t) => [
        policyProjection(t, effectiveExpenseSpendingCategorySql),
      ],
    },
    expense_product_resolution: {
      expected: (t) => policyProjection(t, expenseProductExpectedSql),
      missing: (t) => sql`${t.productId} IS NULL`,
      fingerprint: (t) => [
        policyProjection(t, expenseProductExpectedSql),
        sql`${t.productId}`,
      ],
    },
  },
});
