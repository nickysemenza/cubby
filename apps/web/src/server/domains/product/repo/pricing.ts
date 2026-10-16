import type { FieldResolution } from "@cubby/schemas/field-resolution";
import {
  type IngredientId,
  type ProductId,
  productId,
} from "@cubby/schemas/identifiers";
import type { ProductTopLevelOut } from "@cubby/schemas/product";
import { round2 } from "@cubby/shared";
import type { AnyColumn } from "drizzle-orm";
import { and, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  getDb,
  notDeleted,
  unwrapDb,
  uuidArrayParam,
} from "~/server/db/helpers";
import { product } from "~/server/db/schema";
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
} from "~/server/domains/product/repo/kit-projection";
import type { QualityReadContext } from "~/server/generic/data-quality/repo/registry";

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

const roundOrNull = (value: number | null): number | null =>
  value === null ? null : round2(value);

/**
 * Resolve the public pricing contract from the manual override and the live
 * Expense aggregate. Historical money never lands on Product: the aggregate is
 * rebuilt from Expense whenever a caller needs it.
 */
export const resolveProductPricing = (
  explicitPrice: number | null,
  aggregate: PricingAggregate = EMPTY_AGGREGATE,
): ProductPricing => {
  const derivedPrice = roundOrNull(derivedPriceExact(aggregate));
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

/** Preserve assignment intent while reusing the canonical rounded price rule. */
export const resolveProductPriceField = (
  storedPrice: number | null,
  pricing: ProductPricing,
): FieldResolution => ({
  mode: storedPrice !== null ? "explicit" : "inherit",
  storedValue: storedPrice,
  value: pricing.effectivePrice,
  fallbackValue: pricing.derivedPrice,
  source:
    storedPrice !== null
      ? "manual valuation price"
      : pricing.derivedPrice !== null
        ? "expense-derived unit price"
        : "no valuation price",
  // The fallback aggregates live Expense history, including kit shares; it
  // cannot honestly point at one Expense or Purchase as its source record.
  sourceEntity: null,
  matchesFallback: storedPrice !== null && storedPrice === pricing.derivedPrice,
  canReset: storedPrice !== null,
});

/**
 * This product's OWN acquisition rows: all-history, live, actual, positive,
 * principal. Correlated on `ka."productId"` so the kit walk can evaluate it for
 * an ancestor as readily as for the product itself.
 *
 * These predicates and measures define an acquisition once. Scalar and batch
 * pricing use the correlated aggregate through {@link kitProjectionFrom};
 * the full-filter footer groups the same measures for visited ancestors.
 */
const PRICING_OWN_MEASURES = `sum(kpe."cost") FILTER (WHERE kpe."productQuantity" IS NOT NULL) AS "knownCost",
         sum(abs(kpe."productQuantity")) AS "knownUnitCount",
         count(*) FILTER (WHERE kpe."productQuantity" IS NOT NULL) AS "knownExpenseCount",
         count(*) FILTER (WHERE kpe."productQuantity" IS NULL) AS "unknownExpenseCount"`;

const PRICING_OWN_PREDICATES = `kpe."deletedAt" IS NULL
     AND kpe."future" = false
     AND kpe."lineKind" = 'principal'
     AND kpe."cost" > 0`;

const PRICING_OWN_AGGREGATE = `SELECT ${PRICING_OWN_MEASURES}
    FROM "Expense" kpe
   WHERE kpe."productId" = ka."productId"
     AND ${PRICING_OWN_PREDICATES}`;

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
 * Catalog evidence and the filtered footer group live sibling quantities and
 * own acquisition rows once for the visited ancestors. Page-sized reads keep
 * the correlated aggregate so a small scope does not scan unrelated history.
 */
const groupedProductPriceSql = (
  seed: SQL,
): SQL => sql`${kitAncestorCteSql(seed, { groupedSiblingQuantities: true })}, kit_own_ids AS MATERIALIZED (
    SELECT DISTINCT ka."productId" FROM kit_anc ka
  ), kit_own AS MATERIALIZED (
    SELECT kpe."productId", ${sql.raw(PRICING_OWN_MEASURES)}
      FROM "Expense" kpe
      JOIN kit_own_ids koi ON koi."productId" = kpe."productId"
     WHERE ${sql.raw(PRICING_OWN_PREDICATES)}
     GROUP BY kpe."productId"
  )
  SELECT ka.target AS "entityId", ${sql.raw(PROJECTED_DERIVED_PRICE)} AS "derivedPrice"
  FROM kit_anc ka LEFT JOIN kit_own ko ON ko."productId" = ka."productId"
  GROUP BY ka.target`;

/** Numeric evidence for bounded quality hydration; an omitted scope shares catalog work. */
export const productPriceEvidenceSql = (ids?: SQL): SQL => {
  if (ids === undefined)
    return groupedProductPriceSql(kitSeedForProductIds([], true));
  return sql`${kitAncestorCteSql(sql`SELECT kp."id", kp."id", 1::numeric, 1::numeric, 0 FROM "Product" kp WHERE kp."id" = ANY(${uuidArrayParam(ids)})`)}
    SELECT ka.target AS "entityId", ${sql.raw(PROJECTED_DERIVED_PRICE)} AS "derivedPrice"
    ${sql.raw(PRICING_PROJECTION_FROM)} GROUP BY ka.target`;
};

/** A closed membership predicate: callers need no derived-table alias in their FROM. */
export const hasDerivedProductPriceSql = (
  productId: AnyColumn,
  context?: QualityReadContext,
): SQL =>
  context?.hasDerivedValue
    ? context.hasDerivedValue("derivedPrice", productId)
    : context?.derivedAlias
      ? sql`${sql.identifier(context.derivedAlias)}."derivedPrice" IS NOT NULL`
      : sql`${productId} IN (
  SELECT price_evidence."entityId" FROM (${productPriceEvidenceSql()}) price_evidence
  WHERE price_evidence."derivedPrice" IS NOT NULL
)`;

const productPriceSumSql = (whereClause: SQL | undefined): SQL<number> => {
  const condition = whereClause ?? sql`TRUE`;
  const derived = groupedProductPriceSql(sql`
    SELECT "Product"."id", "Product"."id", 1::numeric, 1::numeric, 0
      FROM "Product"
     WHERE ${condition} AND "Product"."price" IS NULL
  `);
  return sql<number>`SELECT (COALESCE((
    SELECT sum("Product"."price"::numeric) FROM "Product"
     WHERE ${condition} AND "Product"."price" IS NOT NULL
  ), 0) + COALESCE((SELECT sum(price."derivedPrice"::numeric) FROM (${derived}) price), 0))::double precision AS "priceSum"`;
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
 * Numeric scalar for exception fingerprints and callers evaluating one Product.
 * Keep the interpolated column: Drizzle rewrites it to the enclosing alias.
 * Acquisition predicates, kit weights, and rounding share the batch definitions.
 */
export const derivedPriceFilterSql = (productId: AnyColumn) =>
  sql`(${kitAncestorCteSql(
    sql`SELECT ${productId}, ${productId}, 1::numeric, 1::numeric, 0`,
  )}
      SELECT ${sql.raw(PROJECTED_DERIVED_PRICE)}
      ${sql.raw(PRICING_PROJECTION_FROM)})`;
