import { sql, type SQL } from "drizzle-orm";

import { expense } from "~/server/db/schema";
import { expenseSpendingAllocationSql } from "~/server/repo/expense-spending-allocation";
import { expenseProductExpectedSql } from "~/server/repo/purchase-evidence-policy";

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
        sql`NOT EXISTS (SELECT 1 FROM (${expenseSpendingAllocationSql(sql`ARRAY[${t.id}]::uuid[]`)}) a WHERE a."expenseId"=${t.id}) OR EXISTS (SELECT 1 FROM (${expenseSpendingAllocationSql(sql`ARRAY[${t.id}]::uuid[]`)}) a WHERE a."expenseId"=${t.id} AND (a."spendingCategoryId" IS NULL OR a.incomplete))`,
      fingerprint: (t) => [
        sql`(SELECT jsonb_agg(jsonb_build_array(a."spendingCategoryId",a.amount,a.incomplete) ORDER BY a."spendingCategoryId") FROM (${expenseSpendingAllocationSql(sql`ARRAY[${t.id}]::uuid[]`)}) a WHERE a."expenseId"=${t.id})`,
      ],
    },
    // Only a merchandise line (one whose Product identity is expected) feeds
    // the quantity ledger; a fee, tax, or service line has no unit count.
    expense_quantity: {
      expected: (t) =>
        sql`(${t.future} = false AND ${policyProjection(t, expenseProductExpectedSql)})`,
      missing: (t) => sql`${t.productQuantity} IS NULL`,
      fingerprint: (t) => [
        sql`${t.future}`,
        policyProjection(t, expenseProductExpectedSql),
        sql`${t.productQuantity}`,
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
