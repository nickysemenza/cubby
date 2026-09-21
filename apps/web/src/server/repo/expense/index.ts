/**
 * Expense repository — public API barrel.
 *
 * An Expense is ONE categorized line of spend, and **all money in the system
 * lives here** — every `SUM(cost)` in the codebase reads this table alone. It
 * hangs off two optional parents: a `Project` (its budget envelope) and a
 * `Purchase` (the vendor order/receipt event it was part of). See
 * packages/schemas/src/project.ts for the domain doc comment. Import expense
 * operations from `~/server/repo/expense` (this barrel).
 *
 *   CRUD      → `crud.ts`      (create / delete hand-rolled; get/update go
 *                                through `createEntityCrud` — no dependency
 *                                edges, no rollups, so the shared factory
 *                                fits directly. `update` is wrapped to resolve
 *                                `{vendor, orderId}` into `purchaseId`.)
 *   LOOKUP    → `lookup.ts`    (filtered/sorted/paginated list; also exports
 *                                `buildExpenseWhereClause`. `analytics.ts`
 *                                imports it directly — an internal sibling
 *                                seam, not the barrel — but it IS re-exported
 *                                below for `repo/project/portfolio-analytics.ts`,
 *                                a cross-directory consumer that has no
 *                                sibling-import path to it.)
 *   ANALYTICS → `analytics.ts` (server-side grouped SQL aggregates for charts)
 *   MATCHING  → `match.ts`     (read-only reconciliation matcher: ranks vendor
 *                                export lines against the ledger, one query per
 *                                batch. Shares none of `lookup.ts`'s filter
 *                                machinery, hence its own file.)
 *
 * Sibling relationships: `expense.projectId` references `project` (feeds its
 * `spent`/`expenseCount` rollup — see project/analytics.ts);
 * `expense.purchaseId` references `purchase`, through which `vendor` and
 * `orderId` are resolved on read (see repo/purchase.ts, repo/vendor.ts).
 * `helpers.ts` (row→API mapping) is internal.
 */

export {
  expenseAnalytics,
  expenseMonthlySummary,
  expenseTradeAffinity,
} from "./analytics";
export {
  createExpense,
  deleteExpenses,
  getExpenseByID,
  getExpenseByShortcode,
  setExpensesCostType,
  setExpensesTrade,
  updateExpense,
} from "./crud";
export { expenseList } from "./lookup";
export { matchExpenses } from "./match";
