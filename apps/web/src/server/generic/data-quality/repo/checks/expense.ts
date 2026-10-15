import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import { sql, type SQL } from "drizzle-orm";

import { expense } from "~/server/db/schema";
import {
  expenseDerivedValueSql,
  expenseDerivedReadSql,
} from "~/server/domains/expense/repo/expense-derived-read";
import { expenseProductExpectedSql } from "~/server/domains/purchase/repo/purchase-evidence-policy";

import { defineEntityChecks, type QualityReadContext } from "../registry";

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

const categoryEvidence = <K extends "missing" | "evidence">(
  field: K,
  t: Expense,
  context?: QualityReadContext,
): SQL =>
  context
    ? sql`${sql.identifier(context.derivedAlias)}.${sql.identifier(field)}`
    : expenseDerivedValueSql(field, sql`${t.id}`);

export const expenseChecks = defineEntityChecks({
  entity: "expense",
  table: expense,
  derivedRead: (ids) => sql`SELECT "expenseId" AS "entityId", missing, evidence
    FROM (${expenseDerivedReadSql("categoryEvidence", { expenseIds: ids })}) evidence`,
  checks: {
    expense_receipt_role: {
      expected: (t: Expense) => sql`${t.future} = false`,
      missing: (t: Expense) =>
        sql`${t.lineKind} = ${expenseLineKindSchema.enum.unclassified}`,
      fingerprint: (t: Expense) => [sql`${t.future}`, sql`${t.lineKind}`],
    },
    expense_cost: {
      // A future (planned, not yet spent) line may be unpriced; once it is
      // no longer future a cost is expected.
      expected: (t: Expense) => sql`${t.future} = false`,
      missing: (t: Expense) => sql`${t.cost} IS NULL`,
      fingerprint: (t) => [sql`${t.future}`, sql`${t.cost}`],
    },
    expense_spending_category: {
      expected: (t) => sql`${t.future} = false`,
      missing: (t, context) =>
        sql`coalesce(${categoryEvidence("missing", t, context)}, true)`,
      fingerprint: (t, context) => [categoryEvidence("evidence", t, context)],
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
