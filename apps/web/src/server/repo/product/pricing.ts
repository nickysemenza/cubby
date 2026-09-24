import {
  type IngredientId,
  type ProductId,
  productId,
} from "@cubby/schemas/identifiers";
import type { ProductTopLevelOut } from "@cubby/schemas/product";
import type { AnyColumn } from "drizzle-orm";
import { and, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { product } from "~/server/db/schema";
import { getDb, notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import {
  costWeighted,
  kitAncestorCteSql,
  kitAncestorCteText,
  kitProjectionFrom,
  kitSeedForProductAlias,
  kitSeedForProductIds,
  ownOnly,
  projectionRows,
  unitWeighted,
} from "~/server/repo/product/kit-projection";

export type ProductPricing = ProductTopLevelOut["pricing"];

export type PricingAggregate = Omit<
  z.infer<typeof pricingAggregateRowSchema>,
  "productId"
>;

const EMPTY_AGGREGATE: PricingAggregate = {
  knownCost: 0,
  knownExpenseCount: 0,
  unknownExpenseCount: 0,
  knownUnitCount: 0,
};

const pricingAggregateRowSchema = z.object({
  productId,
  knownCost: z.number(),
  knownUnitCount: z.number(),
  knownExpenseCount: z.number().int(),
  unknownExpenseCount: z.number().int(),
});

/**
 * The weighted all-history unit cost, UNROUNDED.
 *
 * `resolveProductPricing` rounds this to cents because `derivedPrice` is shown
 * as a price. Valuation must not: rounding the quotient BEFORE quantity
 * multiplies it is a real error. A kit split into 2 units at a $37.97 ledger
 * cost derives $18.985/unit, which rounds to $18.99 and re-multiplies to
 * $37.98 — two cents the ledger never spent.
 *
 * Stated honestly, feeding the exact value to the valuation money edge fully
 * fixes only the case where ONE entry holds all N units (exact × N is exact).
 * Where the units span several entries it merely REDUCES the artifact: each
 * entry's `valuation` still rounds independently into a `real` column, so the
 * sum can still miss by cents.
 */
const derivedPriceExact = (aggregate: PricingAggregate): number | null =>
  aggregate.knownUnitCount > 0
    ? aggregate.knownCost / aggregate.knownUnitCount
    : null;

const round2 = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 100) / 100;

/**
 * Resolve the public pricing contract from the manual override and the live
 * Expense aggregate. Historical money never lands on Product: the aggregate is
 * rebuilt from Expense whenever a caller needs it.
 */
export const resolveProductPricing = (
  explicitPrice: number | null,
  aggregate: PricingAggregate = EMPTY_AGGREGATE,
): ProductPricing => {
  const derivedPrice = round2(derivedPriceExact(aggregate));
  const effectivePrice = explicitPrice ?? derivedPrice;
  return {
    derivedPrice,
    effectivePrice,
    source:
      explicitPrice !== null
        ? "explicit"
        : derivedPrice !== null
          ? "derived"
          : "none",
    knownExpenseCount: aggregate.knownExpenseCount,
    unknownExpenseCount: aggregate.unknownExpenseCount,
    knownUnitCount: aggregate.knownUnitCount,
    partial:
      aggregate.knownExpenseCount > 0 && aggregate.unknownExpenseCount > 0,
  };
};

/**
 * This product's OWN acquisition rows: all-history, live, actual, positive,
 * principal. Correlated on `ka."productId"` so the kit walk can evaluate it for
 * an ancestor as readily as for the product itself.
 *
 * These predicates are the money side's definition of "an acquisition", and
 * they exist exactly once — every pricing path below is this aggregate seen
 * through {@link kitProjectionFrom}.
 */
const PRICING_OWN_AGGREGATE = `SELECT sum(kpe."cost") FILTER (WHERE kpe."productQuantity" IS NOT NULL) AS "knownCost",
         sum(abs(kpe."productQuantity")) AS "knownUnitCount",
         count(*) FILTER (WHERE kpe."productQuantity" IS NOT NULL) AS "knownExpenseCount",
         count(*) FILTER (WHERE kpe."productQuantity" IS NULL) AS "unknownExpenseCount"
    FROM "Expense" kpe
   WHERE kpe."productId" = ka."productId"
     AND kpe."deletedAt" IS NULL
     AND kpe."future" = false
     AND kpe."lineKind" = 'principal'
     AND kpe."cost" > 0`;

const PRICING_PROJECTION_FROM = kitProjectionFrom(PRICING_OWN_AGGREGATE);

// `abs`, because `productQuantity` is signed. The `cost > 0` filter above
// already excludes discards, but it does not stop a sign error on an
// acquisition row — and a negative `knownUnitCount` would divide the derived
// unit price negative, which flows straight through `InventoryEntry.valuation`
// into the location rollup.
const PROJECTED_KNOWN_COST = costWeighted(`"knownCost"`);
const PROJECTED_KNOWN_UNITS = unitWeighted(`"knownUnitCount"`);

/**
 * The blended aggregate per Product: its own acquisition rows PLUS its
 * quantity-weighted share of every kit it is a live component of. The one query
 * behind both {@link loadProductPricing} and {@link loadExactEffectivePrices},
 * so the two can never disagree about which Expense rows count.
 *
 * The two expense COUNTS stay own-only. They describe this product's own
 * data-entry debt — `partial` means "some of ITS lines lack a quantity" — and a
 * parent's lines are not this product's lines. A part that prices purely from
 * its kit therefore reports zero known lines beside a real derived price, which
 * is the honest reading: nothing was ever booked against it directly.
 */
const loadPricingAggregates = async (
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
  options: { wholeCatalog?: boolean },
): Promise<Map<ProductId, PricingAggregate>> => {
  const query = sql`${kitAncestorCteSql(
    kitSeedForProductIds(ids, options.wholeCatalog ?? false),
  )}
    SELECT ka.target AS "productId",
           COALESCE(${sql.raw(PROJECTED_KNOWN_COST)}, 0)::double precision AS "knownCost",
           COALESCE(${sql.raw(PROJECTED_KNOWN_UNITS)}, 0)::double precision AS "knownUnitCount",
           COALESCE(${sql.raw(ownOnly(`"knownExpenseCount"`))}, 0)::int AS "knownExpenseCount",
           COALESCE(${sql.raw(ownOnly(`"unknownExpenseCount"`))}, 0)::int AS "unknownExpenseCount"
      ${sql.raw(PRICING_PROJECTION_FROM)}
     GROUP BY ka.target`;

  const rows = projectionRows(
    await unwrapDb(db).execute(query),
    pricingAggregateRowSchema,
  );

  const aggregateById = new Map<ProductId, PricingAggregate>();
  for (const row of rows) {
    aggregateById.set(row.productId, {
      knownCost: Number(row.knownCost),
      knownExpenseCount: Number(row.knownExpenseCount),
      unknownExpenseCount: Number(row.unknownExpenseCount),
      knownUnitCount: Number(row.knownUnitCount),
    });
  }
  return aggregateById;
};

/**
 * Batch-load the public pricing contract.
 *
 * `wholeCatalog` drops the id filter on the projection seed. Pass it only when
 * `products` already IS every live product: the returned map is still built
 * from `products`, so surplus aggregate rows are never looked up and the output
 * is identical either way. It exists because the coverage detector hands this
 * the entire catalog and the id list is then pure overhead.
 *
 * The aggregate is now a per-seed correlated lateral rather than one grouped
 * scan, because the kit walk has to evaluate it for a product's ANCESTORS too,
 * and those are not known until the recursion has run. That trades the
 * whole-catalog HashAggregate for one index scan per seed — the right trade for
 * the page-sized calls that dominate, and the reason `wholeCatalog` is now about
 * bind parameters rather than about plan shape.
 */
export const loadProductPricing = async (
  db: Database | DrizzleTransaction,
  products: ReadonlyArray<{ id: ProductId; price: number | null }>,
  options: { wholeCatalog?: boolean } = {},
): Promise<Map<ProductId, ProductPricing>> => {
  const ids = products.map((product) => product.id);
  if (ids.length === 0) return new Map();

  const aggregateById = await loadPricingAggregates(db, ids, options);
  return new Map(
    products.map((product) => [
      product.id,
      resolveProductPricing(product.price, aggregateById.get(product.id)),
    ]),
  );
};

/**
 * The price the synthesized `1 each = $X` valuation edge is built from:
 * `explicit ?? {@link derivedPriceExact}`, i.e. `effectivePrice` without the
 * cent rounding. The explicit override is user-entered and already
 * cent-precise, so only the derived half differs.
 *
 * Server-internal on purpose — it is deliberately NOT part of `ProductPricing`,
 * because that type IS the wire contract and every product payload, form, and
 * fixture would otherwise have to carry a field that exists only to keep
 * rounding out of a multiplication.
 */
export const loadExactEffectivePrices = async (
  db: Database | DrizzleTransaction,
  products: ReadonlyArray<{ id: ProductId; price: number | null }>,
): Promise<Map<ProductId, number | null>> => {
  const ids = products.map((product) => product.id);
  if (ids.length === 0) return new Map();

  const aggregateById = await loadPricingAggregates(db, ids, {});
  return new Map(
    products.map((product) => [
      product.id,
      product.price ??
        derivedPriceExact(aggregateById.get(product.id) ?? EMPTY_AGGREGATE),
    ]),
  );
};

/**
 * Load pricing for every live Product attached to a set of Ingredients.
 *
 * The costing path knows Ingredient ids before it has materialized their
 * Product relations, so this loader can run concurrently with that relational
 * fetch. It was a fourth hand-written copy of the pricing aggregate — a join
 * shape that had to be kept predicate-for-predicate identical to
 * {@link loadProductPricing} by reading. Resolving the ids first and delegating
 * makes that structural: there is nothing left here to diverge.
 */
export const loadProductPricingForIngredientIds = async (
  db: Database | DrizzleTransaction,
  ingredientIds: readonly IngredientId[],
): Promise<Map<ProductId, ProductPricing>> => {
  if (ingredientIds.length === 0) return new Map();

  const products = await unwrapDb(db).query.product.findMany({
    where: and(
      notDeleted(product),
      inArray(product.ingredientId, [...ingredientIds]),
    ),
    columns: { id: true, price: true },
  });
  return loadProductPricing(db, products);
};

export const enrichProductRowsWithPricing = async <
  T extends { id: ProductId; price: number | null },
>(
  db: Database | DrizzleTransaction,
  products: readonly T[],
): Promise<Array<T & { pricing: ProductPricing }>> => {
  const pricing = await loadProductPricing(db, products);
  return products.map((product) => ({
    ...product,
    pricing: pricing.get(product.id) ?? resolveProductPricing(product.price),
  }));
};

export const loadEffectiveProductPricesById = async (
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
): Promise<Map<ProductId, number | null>> => {
  if (ids.length === 0) return new Map();
  const rows = await unwrapDb(db).query.product.findMany({
    where: and(inArray(product.id, [...ids]), notDeleted(product)),
    columns: { id: true, price: true },
  });
  const pricing = await loadProductPricing(db, rows);
  return new Map(
    rows.map((row) => [row.id, pricing.get(row.id)?.effectivePrice ?? null]),
  );
};

/** Ingredient identities whose recipe costs depend on these Products. */
export const loadIngredientIdsForProducts = async (
  db: Database,
  ids: readonly ProductId[],
): Promise<IngredientId[]> => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).query.product.findMany({
    where: and(
      inArray(product.id, [...ids]),
      isNotNull(product.ingredientId),
      notDeleted(product),
    ),
    columns: { ingredientId: true },
  });
  return rows.flatMap((row) =>
    row.ingredientId === null ? [] : [row.ingredientId],
  );
};

/** Divide, round to cents — shared by the sort twin and the filter twin below. */
const PROJECTED_DERIVED_PRICE = `round((${PROJECTED_KNOWN_COST} / NULLIF(${PROJECTED_KNOWN_UNITS}, 0))::numeric, 2)::double precision`;

/**
 * Correlated SQL for Product root-list sorting and aggregation (filtering goes
 * through {@link derivedPriceFilterSql}). `productAlias` must be the query's
 * known SQL alias (RQB uses `product`).
 *
 * The twin of {@link loadProductPricing}, and no longer a restatement of it: the
 * Expense predicates, the `abs()`, the kit walk, the weighting, and the divide
 * all come from the same constants the loader builds on. All that is left here
 * is how the seed names its product — a hand-qualified alias. A divergence here
 * would sort by a number the user is never shown, which is why there is nothing
 * left to diverge.
 */
const derivedProductPriceSql = (productAlias = '"product"') =>
  `(${kitAncestorCteText(kitSeedForProductAlias(productAlias))}
    SELECT ${PROJECTED_DERIVED_PRICE}
    ${PRICING_PROJECTION_FROM})`;

export const effectiveProductPriceSql = (productAlias = '"product"') =>
  `COALESCE(${productAlias}."price", ${derivedProductPriceSql(productAlias)})`;

/**
 * The list footer sums the same effective prices as the rows, but projects all
 * filtered unpriced products in one kit walk. A correlated effective-price
 * scalar otherwise repeats the recursive walk once per catalog product.
 */
export const productPriceSumSql = (
  whereClause: SQL | undefined,
): SQL<number> => {
  const condition = whereClause ?? sql`TRUE`;
  return sql<number>`${kitAncestorCteSql(sql`
    SELECT "Product"."id", "Product"."id", 1::numeric, 1::numeric, 0
      FROM "Product"
     WHERE ${condition} AND "Product"."price" IS NULL
  `)}, derived AS (
    SELECT ka.target, ${sql.raw(PROJECTED_DERIVED_PRICE)} AS price
      ${sql.raw(PRICING_PROJECTION_FROM)}
     GROUP BY ka.target
  )
  SELECT (COALESCE((
    SELECT sum("Product"."price"::numeric) FROM "Product"
     WHERE ${condition} AND "Product"."price" IS NOT NULL
  ), 0) + COALESCE((SELECT sum(price::numeric) FROM derived), 0))::double precision AS "priceSum"`;
};

export const loadProductPriceSum = async (
  db: Database | DrizzleTransaction,
  whereClause: SQL | undefined,
): Promise<number> => {
  const rows = projectionRows(
    await unwrapDb(db).execute(productPriceSumSql(whereClause)),
    z.object({ priceSum: z.number() }),
  );
  return rows[0]?.priceSum ?? 0;
};

/**
 * The same derived price as a Drizzle fragment, for the Product list's shared
 * `whereClause` — NULL exactly when no acquisition, own or projected, prices
 * this product.
 *
 * Interpolates `product.id` rather than hand-qualifying an alias, the opposite
 * of the sort twin above and for the reason `expectedQuantityFilterSql`
 * (quantity-ledger.ts) spells out: one `whereClause` reaches three query
 * builders under three different aliases, and only an interpolated Drizzle
 * column is rewritten to whichever is in scope.
 *
 * It exists because a price filter written any other way is a fourth definition
 * of "an acquisition" free to drift from the three above — and it did. The flat
 * `Expense`-keyed `IN` list this replaced predated the kit projection, so the
 * "Stocked but unpriced" view listed components whose own price column rendered
 * the projected number the filter could not see.
 *
 * The `kpe` alias inside {@link PRICING_OWN_AGGREGATE} is not cosmetic: the
 * footer-total query nests this whole where-clause inside a statement that
 * already has `"Expense"` in scope.
 */
export const derivedPriceFilterSql = (productId: AnyColumn) =>
  sql`(${kitAncestorCteSql(
    sql`SELECT ${productId}, ${productId}, 1::numeric, 1::numeric, 0`,
  )}
      SELECT ${sql.raw(PROJECTED_DERIVED_PRICE)}
      ${sql.raw(PRICING_PROJECTION_FROM)})`;
