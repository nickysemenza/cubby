import type { ExpenseFilters } from "@cubby/schemas/project";
import { sql, type SQL } from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { expense } from "~/server/db/schema";

import { getDb, uuidArrayParam } from "./database-helpers";
import { expenseAggregateFields } from "./expense-aggregate-sql";
import {
  expenseAllocationScopeConditionSql,
  expenseJointAllocationSql,
  type ExpenseAllocationProjectScope,
} from "./expense-project-allocation";
import {
  buildExpenseWhereClause,
  resolveExpenseProjectAllocationScope,
} from "./expense/lookup";

/** One row per selected expense; scope filters rounded shares, never the sibling denominator. */
export function expenseDerivedCostsSql(
  scope?: ExpenseAllocationProjectScope,
  expenseIds?: SQL,
): SQL {
  if (!scope)
    return sql`SELECT source."id" AS "expenseId", source."cost" AS cost FROM "Expense" source WHERE source."deletedAt" IS NULL
    ${expenseIds ? sql`AND source."id" = ANY(${uuidArrayParam(expenseIds)})` : sql``}`;
  const condition = expenseAllocationScopeConditionSql("allocation", scope);
  const categories =
    scope.spendingCategoryIds !== undefined ||
    scope.categoryPresence !== undefined ||
    scope.trades !== undefined ||
    scope.costTypes !== undefined;
  return sql`SELECT allocation."expenseId", (sum(allocation."attributedCents"::bigint) / 100.0)::float8 AS cost
    FROM (${expenseJointAllocationSql(expenseIds, undefined, { categories })}) allocation
    WHERE ${condition ?? sql`true`}
    GROUP BY allocation."expenseId"`;
}

/** Request-local prepared scope and set-based total relation shared by analytical callers. */
export async function prepareExpenseDerivedRead(
  db: Database,
  filters: ExpenseFilters,
) {
  const scope = await resolveExpenseProjectAllocationScope(db, filters);
  // Scope membership is supplied by the grouped join, rather than a correlated
  // allocation query per ledger row. All other ledger filters remain canonical.
  const where = await buildExpenseWhereClause(db, filters, {
    projectScope: undefined,
  });
  const selectedIds = sql`ARRAY(SELECT ${expense.id} FROM ${expense} WHERE ${where ?? sql`true`})`;
  const relation = sql`(${expenseDerivedCostsSql(scope, selectedIds)}) derived_cost`;
  const cost = scope
    ? sql<number | null>`derived_cost.cost`
    : sql<number | null>`${expense.cost}`;
  const join = sql`derived_cost."expenseId" = ${expense.id}`;
  const select = <Fields extends SelectedFields>(fields: Fields) => {
    const query = getDb(db).select(fields).from(expense);
    return scope ? query.innerJoin(relation, join) : query;
  };
  return {
    scope,
    where,
    cost,
    select,
    aggregate: expenseAggregateFields(cost),
    allocations: sql`(${expenseJointAllocationSql(selectedIds)}) allocation`,
  };
}
