/**
 * Shared expense SQL fragments — the aggregate columns used by BOTH
 * `expense/analytics.ts` (the ledger's own breakdowns) and
 * `project/portfolio-analytics.ts` (the project-scoped chart aggregates), plus
 * the acquisition-direction predicates at the bottom, which the Product list's
 * value, sort, and filter sites all read so they cannot drift apart.
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
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
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

/**
 * Does this Expense line say the product was ACQUIRED, rather than sold,
 * returned, or discarded?
 *
 * The ledger's own rule, documented on `Expense.productQuantity` and in
 * `docs/terminology.md`: money direction wins, and the quantity's sign is
 * consulted only when no money moved. So a row is an exit when its cost is
 * negative, or when it moved no money and its quantity is negative (a
 * discard). Everything else counts, deliberately including the $0 and
 * unknown-quantity lines — a free promo item or an unpriced line is still a
 * unit that arrived.
 *
 * A product-linked Expense is NOT automatically evidence of acquisition: a
 * disposal is modelled as a Purchase whose Expenses sum negative
 * (`repo/product/ownership.ts`), so treating every product-linked Expense as
 * an acquisition files eBay sales and disposals under "bought". That is the
 * whole reason this predicate exists; deleting it silently reintroduces the
 * wrong rows.
 *
 * Raw text rather than interpolated Drizzle columns because the correlated
 * subqueries below must alias their `"Expense"` — an interpolated
 * `expense.cost` there binds to the wrong table or is prefix-stripped into a
 * self-join. See `correlated()` in `database-helpers/query.ts`.
 */
export const expenseAcquisitionSql = (alias: string): string =>
  `(${alias}."cost" > 0 OR (COALESCE(${alias}."cost", 0) = 0 AND COALESCE(${alias}."productQuantity", 0) >= 0))`;

/**
 * The last date a product was ACQUIRED — the Product list's "Purchase date".
 *
 * Dates from the linked Purchase where one exists, else from the Expense
 * itself. The fallback is load-bearing, not defensive: several acquisitions
 * are deliberately Purchase-less because they had no counterparty — items
 * conveyed with the house at closing, and found/salvaged tools. Their own
 * expense notes say so. Without the COALESCE they would render blank while
 * their eBay disposal supplied a "purchase date".
 *
 * Stated once, projected twice, because the two roles must spell the product
 * id differently and neither spelling works in the other's position:
 *
 * - {@link productAcquisitionDateSql} hand-qualifies the alias, for the list
 *   cell and the ORDER BY. An interpolated `PgColumn` there is prefix-stripped
 *   by `buildSelection` into a silent self-join (see `correlated()`).
 * - {@link productAcquisitionDateFilterSql} interpolates the real column, for
 *   the shared `whereClause` — which reaches the relational query builder
 *   (alias `"product"`), `$count`, and a plain `select().from(product)`
 *   (alias `"Product"`), so no single hand-written alias is correct there.
 *
 * Everything else in the body is a literal chunk, so both projections survive
 * the alias rewriting each builder applies.
 */
const acquisitionDateBody = (productRef: SQL): SQL<string | null> => sql`(
  SELECT max(COALESCE(pad_p."date", pad_e."date"))
    FROM "Expense" pad_e
    LEFT JOIN "Purchase" pad_p
      ON pad_p."id" = pad_e."purchaseId" AND pad_p."deletedAt" IS NULL
   WHERE pad_e."productId" = ${productRef}
     AND pad_e."deletedAt" IS NULL
     AND pad_e."future" = false
     AND ${sql.raw(expenseAcquisitionSql("pad_e"))})`;

/** Correlated scalar for the list cell and ORDER BY. See the body's doc. */
export const productAcquisitionDateSql = (
  productAlias = '"product"',
): SQL<string | null> => acquisitionDateBody(sql.raw(`${productAlias}."id"`));

/** WHERE-clause form for the shared filter builder. See the body's doc. */
export const productAcquisitionDateFilterSql = (
  productId: AnyColumn,
): SQL<string | null> => acquisitionDateBody(sql`${productId}`);

/**
 * A product's live-expense rollups: how many lines point at it, and their net
 * basis.
 *
 * Both are plain sums over EVERY live line, acquisitions and exits alike —
 * unlike {@link productAcquisitionDateSql}, which is directional. A negative
 * row (refund, disposal) is real money in this ledger, so the net basis is
 * `SUM(Expense.cost)` with no sign filter; `COALESCE` matters because a product
 * with no expenses nets $0, not null.
 *
 * Same two-projection shape as the acquisition date above, and for the same
 * reason: the cell and ORDER BY need a hand-qualified alias, the shared
 * whereClause needs a real interpolated column. They were three hand copies
 * each until this — correct, but structurally the arrangement that let
 * `purchaseDate` ship wrong in all three places at once.
 */
const expenseCountBody = (productRef: SQL): SQL<number> =>
  sql`(SELECT count(*) FROM "Expense" pec_e
        WHERE pec_e."productId" = ${productRef}
          AND pec_e."deletedAt" IS NULL)`;

const expenseTotalBody = (productRef: SQL): SQL<number> =>
  sql`(SELECT COALESCE(sum(pet_e."cost"), 0)::double precision FROM "Expense" pet_e
        WHERE pet_e."productId" = ${productRef}
          AND pet_e."deletedAt" IS NULL)`;

/** Correlated scalar for the list cell and ORDER BY. */
export const productExpenseCountSql = (
  productAlias = '"product"',
): SQL<number> => expenseCountBody(sql.raw(`${productAlias}."id"`));

/** WHERE-clause form for the shared filter builder. */
export const productExpenseCountFilterSql = (
  productId: AnyColumn,
): SQL<number> => expenseCountBody(sql`${productId}`);

/** Correlated scalar for the list cell and ORDER BY. */
export const productExpenseTotalSql = (
  productAlias = '"product"',
): SQL<number> => expenseTotalBody(sql.raw(`${productAlias}."id"`));

/** WHERE-clause form for the shared filter builder. */
export const productExpenseTotalFilterSql = (
  productId: AnyColumn,
): SQL<number> => expenseTotalBody(sql`${productId}`);
