import { sql } from "drizzle-orm";

import { expense } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Expense = typeof expense;

// `costType` is `NOT NULL` at the DB level (entity-columns.gen.ts) and
// required (non-nullable, no default) in the create schema — every line,
// regardless of `lineKind`, always carries one of materials/tools/services.
// A `costType`-missing check can never fire for any live row, so this entity
// declares only the `expense_cost` check.
export const expenseChecks = defineEntityChecks({
  entity: "expense",
  table: expense,
  checks: {
    expense_cost: {
      // A future (planned, not yet spent) line may be unpriced; once it is
      // no longer future a cost is expected.
      expected: (t: Expense) => sql`${t.future} = false`,
      missing: (t: Expense) => sql`${t.cost} IS NULL`,
    },
  },
});
