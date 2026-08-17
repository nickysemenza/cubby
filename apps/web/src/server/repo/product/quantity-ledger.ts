/**
 * How many units of a Product *should* be on hand, derived from the ledger.
 *
 * Nothing is stored: `Expense.productId`'s doc note is explicit that ownership
 * is derived from Expense rows plus inventory. This module is the one place the
 * quantity side of that derivation lives — the mirror of `pricing.ts`, which
 * owns the money side — so the products list, its filters, and the Problems
 * detector all read the same number.
 *
 * The rule (documented in full on `Expense.productQuantity` in schema.ts):
 * money direction wins, and the quantity's own sign is consulted only when
 * there is no money.
 *
 *   cost > 0 → acquisition of +|qty|
 *   cost < 0 → exit of −|qty|          (both stored signs are legal here)
 *   cost = 0 → signed: +qty is a free acquisition, −qty is a discard
 *   qty 0    → negative cost only: money moved, no unit did — a price
 *              concession with the item kept. Sums to nothing, and is
 *              deliberately NOT an unknown line
 *   qty NULL → unknown; contributes nothing, reported as a line count instead
 *
 * Two deliberate divergences from neighbouring predicates:
 *
 *  - **Every negative line counts as an exit**, not only those inside a
 *    disposal Purchase the way `findSoldButStillStocked` requires. That
 *    detector asks "was this sold off entirely?", where a refund or price
 *    adjustment is noise. This asks "how many units left?", and on live data
 *    218 of 335 negative lines are named returns/refunds sitting inside a
 *    Purchase that nets *positive* — real units going back to the store. The
 *    strict predicate would miss 348 of the 492 exited units.
 *
 *  - **$0 lines participate**, unlike `loadProductPricing`'s `cost > 0`. A free
 *    promo battery on the shelf is genuinely owned, and a discard is genuinely
 *    gone; excluding both would report a shelf full of freebies as expected 0.
 *
 * Unknowns are never guessed at. A quantity-less line contributes nothing to
 * the number and is surfaced as a count, so a partially-quantified product
 * reads as data-entry debt rather than as a confident total.
 *
 * That count is why `0` exists as a distinct value from `NULL`. Both add
 * nothing to the sum, but only NULL is debt. Until 2026-08-17 zero was banned
 * by the CHECK, so the price-concession class had to borrow NULL, and all eight
 * such rows in the ledger lit the `−N?` uncertainty cue beside Expected on
 * products whose count was in fact exactly known. `unknownExitLines` now counts
 * only genuine unknowns — as of the backfill, none.
 */
import type { ProductId } from "@cubby/schemas/identifiers";
import type {
  ProductPickerOnHandOut,
  ProductQuantityLedgerOut,
} from "@cubby/schemas/product";
import type { AnyColumn } from "drizzle-orm";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { expense, inventoryEntry, location } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

export type QuantityLedger = ProductQuantityLedgerOut;

export const EMPTY_QUANTITY_LEDGER: QuantityLedger = {
  acquiredUnits: 0,
  exitedUnits: 0,
  expectedQuantity: 0,
  unknownAcquisitionLines: 0,
  unknownExitLines: 0,
  locationCount: 0,
};

/**
 * The signed per-line contribution — the ledger rule as one SQL expression.
 *
 * Every other query in this module is derived from it rather than restating it:
 * the loader sums its positive and negative halves, and the correlated
 * subquery sums it whole. That is deliberate. A hand-written FILTER predicate
 * beside it would be a second copy of the rule, free to drift, and the failure
 * would be a list that *sorts* by a different number than it *renders*.
 *
 * A NULL cost (an Unclassified row) falls to the ELSE and is read by its
 * quantity's sign, the same as a $0 line — cost unknown is not cost zero, but
 * neither says anything about direction, so the quantity is all there is.
 * NULL quantity yields NULL, which `sum` skips: unknown never guesses at one.
 *
 * `alias` is the Expense alias in the enclosing query.
 */
// Module-private since the over-exited detector became a saved view — the
// three remaining callers are all in this file.
const expenseSignedUnitsSql = (alias: string) =>
  `CASE WHEN ${alias}."cost" > 0 THEN abs(${alias}."productQuantity")
        WHEN ${alias}."cost" < 0 THEN -abs(${alias}."productQuantity")
        ELSE ${alias}."productQuantity"
   END`;

/**
 * Correlated scalar for Product root-list sorting and filtering.
 * `productAlias` must be the enclosing query's alias — the relational query
 * builder uses the lowercase `"product"`, plain selects use `"Product"`.
 *
 * Hand-qualified raw SQL on purpose: an interpolated Drizzle column in a
 * cross-table correlated reference gets prefix-stripped by `buildSelection`
 * and silently self-joins (see the warning block in repo/purchase.ts).
 */
export const expectedQuantitySql = (productAlias = '"product"') =>
  `(SELECT COALESCE(sum(${expenseSignedUnitsSql("eq_e")}), 0)::int
      FROM "Expense" eq_e
     WHERE eq_e."productId" = ${productAlias}."id"
       AND eq_e."deletedAt" IS NULL
       AND eq_e."future" = false
       AND eq_e."productQuantity" IS NOT NULL)`;

/**
 * Live units on shelves — NULL wherever `deriveOnHandUnits` in mappers.ts
 * renders `—`, so nothing can be filtered or ordered by a number the cell never
 * shows. Two predicates carry that, and both mirror the render exactly:
 *
 *  - **The `Location` join.** `relations.product.list` loads live entries and
 *    the mapper drops any whose *location* is soft-deleted.
 *    `InventoryEntry.locationId` is `must-target-live` and production has zero
 *    violations today — exactly why the divergence would go unnoticed.
 *
 *  - **The mixed-unit guard.** Summing `each` against `can` produces a number
 *    that means nothing, so the mapper returns null rather than adding them;
 *    without the same rule here a mixed-unit product could be pulled in by
 *    "Shelf disagrees" on a meaningless sum while its Variance cell read `—`.
 *    Live inventory is essentially all `each`, which again is what would have
 *    kept this quiet.
 *
 * NULL propagates the way the render does: through the subtraction in
 * {@link quantityVarianceSql} (so the sort puts these last, `nulls last`), and
 * through both `<>` and `=` in the variance filter — a mixed-unit product
 * matches neither "mismatched" nor "matched", which is the honest answer.
 *
 * The zero-entry case returns NULL for the same reason (the mapper does too),
 * though the filters also gate on `productIdsWithLiveInventory` and never see
 * it.
 *
 * includes-installed: `expectedQuantitySql` sums Expense rows unconditionally,
 * and a fixture's purchase Expense is one of them — excluding installed rows
 * here would manufacture a permanent negative variance and light "Shelf
 * disagrees" forever on every fixture in the house.
 *
 * includes-locations: on-hand is the UNION of stock and identity — inventory
 * units PLUS the Locations that ARE this product. A packout in service as a
 * bin is a unit you own; counting only the shelf would show it missing against
 * a ledger that recorded buying it. Locations are one unit each, so they add
 * to the sum but never to the distinct-unit test: a mixed-unit shelf is still
 * NULL, and a product with neither entries nor locations is still NULL.
 */
const onHandUnitsSql = (productAlias = '"product"') =>
  `(SELECT CASE
             WHEN ohu_inv.n = 0 AND ohu_loc.n = 0 THEN NULL
             WHEN ohu_inv.units > 1 THEN NULL
             ELSE COALESCE(ohu_inv.qty, 0) + ohu_loc.n
           END::double precision
      FROM (SELECT count(*) AS n,
                   count(DISTINCT ohu_i."amount"->>'unit') AS units,
                   sum((ohu_i."amount"->>'value')::numeric) AS qty
              FROM "InventoryEntry" ohu_i
              JOIN "Location" ohu_l
                ON ohu_l."id" = ohu_i."locationId" AND ohu_l."deletedAt" IS NULL
             WHERE ohu_i."productId" = ${productAlias}."id"
               AND ohu_i."deletedAt" IS NULL) ohu_inv,
           (SELECT count(*) AS n
              FROM "Location" ohu_ol
             WHERE ohu_ol."productId" = ${productAlias}."id"
               AND ohu_ol."deletedAt" IS NULL) ohu_loc)`;

/**
 * Shelf minus ledger. Zero means the two agree; a product with no inventory and
 * no ledger is trivially zero, which is why the *filters* pair this with an
 * "is stocked" predicate rather than treating every untouched product as
 * reconciled.
 *
 * includes-installed: inherited from `onHandUnitsSql` — see that doc.
 */
export const quantityVarianceSql = (productAlias = '"product"') =>
  `(${onHandUnitsSql(productAlias)} - ${expectedQuantitySql(productAlias)})`;

/**
 * The same three scalars as Drizzle fragments, for the Product list's shared
 * `whereClause`.
 *
 * Filters interpolate `product.id` rather than hand-qualifying an alias — the
 * opposite of the sort helpers above, and deliberately so: one `whereClause`
 * is handed to three different query builders (the RQB data query aliased
 * `"product"`, a plain `$count`, and a plain select over `"Product"`), and only
 * an interpolated Drizzle column is rewritten to whichever alias is in scope.
 * A hardcoded alias would be wrong in two of the three.
 *
 * The `eq_e` alias on the inner Expense is not cosmetic: the footer-total query
 * nests this whole where-clause inside a statement that already has `"Expense"`
 * in scope.
 */
export const expectedQuantityFilterSql = (productId: AnyColumn) =>
  sql`(SELECT COALESCE(sum(${sql.raw(expenseSignedUnitsSql("eq_e"))}), 0)::int
         FROM "Expense" eq_e
        WHERE eq_e."productId" = ${productId}
          AND eq_e."deletedAt" IS NULL
          AND eq_e."future" = false
          AND eq_e."productQuantity" IS NOT NULL)`;

/**
 * Same predicates as {@link onHandUnitsSql} — the live-Location join AND the
 * mixed-unit/zero-entry NULLs. Keep the two in step; they are the filter and
 * the sort halves of one rule.
 *
 * includes-installed: inherited from `onHandUnitsSql` — see that doc.
 */
export const onHandUnitsFilterSql = (productId: AnyColumn) =>
  sql`(SELECT CASE
                WHEN ohu_inv.n = 0 AND ohu_loc.n = 0 THEN NULL
                WHEN ohu_inv.units > 1 THEN NULL
                ELSE COALESCE(ohu_inv.qty, 0) + ohu_loc.n
              END::double precision
         FROM (SELECT count(*) AS n,
                      count(DISTINCT ohu_i."amount"->>'unit') AS units,
                      sum((ohu_i."amount"->>'value')::numeric) AS qty
                 FROM "InventoryEntry" ohu_i
                 JOIN "Location" ohu_l
                   ON ohu_l."id" = ohu_i."locationId" AND ohu_l."deletedAt" IS NULL
                WHERE ohu_i."productId" = ${productId}
                  AND ohu_i."deletedAt" IS NULL) ohu_inv,
              (SELECT count(*) AS n
                 FROM "Location" ohu_ol
                WHERE ohu_ol."productId" = ${productId}
                  AND ohu_ol."deletedAt" IS NULL) ohu_loc)`;

/** Does this product carry any product-linked Expense with no quantity? */
export const hasUnknownQuantityLinesSql = (productId: AnyColumn) =>
  sql`EXISTS (SELECT 1 FROM "Expense" uq_e
               WHERE uq_e."productId" = ${productId}
                 AND uq_e."deletedAt" IS NULL
                 AND uq_e."future" = false
                 AND uq_e."productQuantity" IS NULL)`;

/** Batch-load the quantity ledger for a page of products. One grouped query. */
export const loadProductQuantityLedgers = async (
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
): Promise<Map<ProductId, QuantityLedger>> => {
  if (ids.length === 0) return new Map();

  // `GREATEST`/`LEAST` split the one signed expression into its two halves, so
  // `acquiredUnits - exitedUnits` is `sum(signedUnits)` by construction — the
  // same number `expectedQuantitySql` computes for sorting and filtering.
  const signedUnits = sql.raw(expenseSignedUnitsSql('"Expense"'));
  const rows = await unwrapDb(db)
    .select({
      productId: expense.productId,
      acquiredUnits: sql<number>`COALESCE(sum(GREATEST(${signedUnits}, 0)), 0)::int`,
      exitedUnits: sql<number>`COALESCE(sum(-LEAST(${signedUnits}, 0)), 0)::int`,
      // An unknown-quantity line has no direction of its own, so it is bucketed
      // by its money: a NULL cost sits with the acquisitions, matching the
      // signed expression's ELSE.
      unknownAcquisitionLines: sql<number>`count(*) FILTER (WHERE ${expense.productQuantity} IS NULL AND (${expense.cost} IS NULL OR ${expense.cost} >= 0))::int`,
      unknownExitLines: sql<number>`count(*) FILTER (WHERE ${expense.productQuantity} IS NULL AND ${expense.cost} < 0)::int`,
    })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        eq(expense.future, false),
        isNotNull(expense.productId),
        inArray(expense.productId, [...ids]),
      ),
    )
    .groupBy(expense.productId);

  // Second grouped query rather than a join: the Expense aggregate above is
  // grouped by product already, and folding a second one-to-many in would
  // multiply its rows.
  const locationRows = await unwrapDb(db)
    .select({
      productId: location.productId,
      locationCount: sql<number>`count(*)::int`,
    })
    .from(location)
    .where(
      and(
        notDeleted(location),
        isNotNull(location.productId),
        inArray(location.productId, [...ids]),
      ),
    )
    .groupBy(location.productId);
  const locationCounts = new Map<ProductId, number>();
  for (const row of locationRows) {
    if (row.productId === null) continue;
    locationCounts.set(row.productId, Number(row.locationCount));
  }

  const byProduct = new Map<ProductId, QuantityLedger>();
  for (const row of rows) {
    if (row.productId === null) continue;
    const acquiredUnits = Number(row.acquiredUnits);
    const exitedUnits = Number(row.exitedUnits);
    byProduct.set(row.productId, {
      acquiredUnits,
      exitedUnits,
      expectedQuantity: acquiredUnits - exitedUnits,
      unknownAcquisitionLines: Number(row.unknownAcquisitionLines),
      unknownExitLines: Number(row.unknownExitLines),
      locationCount: locationCounts.get(row.productId) ?? 0,
    });
  }

  // A product with locations but no ledger lines has no row above, and its
  // count would otherwise vanish.
  for (const [productId, locationCount] of locationCounts) {
    if (byProduct.has(productId)) continue;
    byProduct.set(productId, {
      acquiredUnits: 0,
      exitedUnits: 0,
      expectedQuantity: 0,
      unknownAcquisitionLines: 0,
      unknownExitLines: 0,
      locationCount,
    });
  }
  return byProduct;
};

/**
 * Attach the ledger to loaded rows. A product with no product-linked Expense
 * gets the empty ledger rather than a null — expected 0 is a real, meaningful
 * answer ("nothing says you own any"), not missing data.
 */
export const enrichProductRowsWithQuantityLedger = async <
  T extends { id: ProductId },
>(
  db: Database | DrizzleTransaction,
  products: readonly T[],
): Promise<Array<T & { quantityLedger: QuantityLedger }>> => {
  const ledgers = await loadProductQuantityLedgers(
    db,
    products.map((product) => product.id),
  );
  return products.map((product) => ({
    ...product,
    quantityLedger: ledgers.get(product.id) ?? EMPTY_QUANTITY_LEDGER,
  }));
};

export interface ProductPickerQuantity {
  quantityLedger: QuantityLedger;
  onHand: ProductPickerOnHandOut;
}

/**
 * Batch-load the compact stock state a picker needs without hydrating the full
 * product graph. It preserves the list/detail rules for live locations,
 * location-as-product ownership, and incompatible mixed inventory units.
 */
export const loadProductPickerQuantities = async (
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
): Promise<Map<ProductId, ProductPickerQuantity>> => {
  if (ids.length === 0) return new Map();

  // Keep these sequential: callers may pass a transaction-bound pg client,
  // which cannot safely execute two queries concurrently (and pg@9 removes
  // the old implicit queuing behavior).
  const ledgers = await loadProductQuantityLedgers(db, ids);
  const inventoryRows = await unwrapDb(db)
    .select({
      productId: inventoryEntry.productId,
      amount: inventoryEntry.amount,
    })
    .from(inventoryEntry)
    .innerJoin(
      location,
      and(eq(location.id, inventoryEntry.locationId), notDeleted(location)),
    )
    .where(
      and(
        notDeleted(inventoryEntry),
        inArray(inventoryEntry.productId, [...ids]),
      ),
    );

  const amountsByProduct = new Map<
    ProductId,
    Array<{ value: number; unit: string }>
  >();
  for (const row of inventoryRows) {
    const amounts = amountsByProduct.get(row.productId) ?? [];
    amounts.push(row.amount);
    amountsByProduct.set(row.productId, amounts);
  }

  const quantities = new Map<ProductId, ProductPickerQuantity>();
  for (const id of ids) {
    const quantityLedger = ledgers.get(id) ?? EMPTY_QUANTITY_LEDGER;
    const amounts = amountsByProduct.get(id) ?? [];
    const units = new Set(amounts.map((amount) => amount.unit));

    let onHand: ProductPickerOnHandOut;
    if (amounts.length === 0 && quantityLedger.locationCount === 0) {
      onHand = { state: "none" };
    } else if (units.size > 1) {
      onHand = { state: "mixed" };
    } else {
      onHand = {
        state: "counted",
        units:
          amounts.reduce((sum, amount) => sum + amount.value, 0) +
          quantityLedger.locationCount,
      };
    }

    quantities.set(id, { quantityLedger, onHand });
  }

  return quantities;
};
