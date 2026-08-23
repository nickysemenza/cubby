/**
 * Shared expense-aggregate SQL fragments, used by BOTH
 * `expense/analytics.ts` (the ledger's own breakdowns) and
 * `project/portfolio-analytics.ts` (the project-scoped chart aggregates).
 *
 * Lives at the repo root rather than inside either `expense/` or `project/`
 * on purpose: `repo/expense/*` already imports from `repo/project/*` in one
 * direction (`expense/crud.ts` imports the project barrel for
 * `assertProjectLive`; `expense/lookup.ts` imports `project/subtree` for its
 * project-presence condition). Adding the reverse edge — either analytics
 * file importing the other's directory directly — would put `repo/project`
 * and `repo/expense` in a bidirectional relationship. This module imports
 * only drizzle + the schema, so it can't sit on a cycle either way, matching
 * the precedent of other repo-root files that span multiple entities (e.g.
 * `repo/dashboard.ts`).
 */
import { sql } from "drizzle-orm";
import { expense } from "~/server/db/schema";

/**
 * actual/committed/credits/net/count — the shared aggregate columns every
 * expense-based breakdown selects. `actual` = live spend already made,
 * `committed` = future/planned spend, `credits` = refunds and price adjustments
 * (stored as negative `cost`, flipped positive here). `net` is the
 * expense's blended total — algebraically `actual + committed - credits`,
 * which telescopes to a plain `sum(cost)` (cost = 0 and NULL cost both
 * contribute nothing to any of the three either). Computed directly as one
 * sum rather than three-way arithmetic to keep the query plan cheap.
 *
 * Negative expenses are real in this app (refunds and large negative price
 * adjustments) — the `filter (where cost > 0 …)` / credits split
 * is load-bearing. Do not "simplify" the sign handling.
 *
 * A fresh object is returned per call since these `sql` fragments get spread
 * into several independent `select()`s across both callers.
 */
export const expenseAggregateFields = () => ({
  actual: sql<number>`coalesce(sum(${expense.cost}) filter (where ${expense.cost} > 0 and ${expense.future} = false), 0)::float`,
  committed: sql<number>`coalesce(sum(${expense.cost}) filter (where ${expense.cost} > 0 and ${expense.future} = true), 0)::float`,
  credits: sql<number>`coalesce(-sum(${expense.cost}) filter (where ${expense.cost} < 0), 0)::float`,
  net: sql<number>`coalesce(sum(${expense.cost}), 0)::float`,
  count: sql<number>`count(*)::int`,
});

/** `"YYYY-MM"` bucket expression, reused for both the SELECT and its GROUP/ORDER BY. */
export const EXPENSE_MONTH_BUCKET = sql<string>`to_char(${expense.date}, 'YYYY-MM')`;
