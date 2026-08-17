import type { IngredientId, ProductId } from "@cubby/schemas/identifiers";
import type { ProductTopLevelOut } from "@cubby/schemas/product";
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { expense, product } from "~/server/db/schema";
import { getDb, notDeleted, unwrapDb } from "~/server/repo/database-helpers";

export type ProductPricing = ProductTopLevelOut["pricing"];

export type PricingAggregate = {
  knownCost: number;
  knownExpenseCount: number;
  unknownExpenseCount: number;
  knownUnitCount: number;
};

const EMPTY_AGGREGATE: PricingAggregate = {
  knownCost: 0,
  knownExpenseCount: 0,
  unknownExpenseCount: 0,
  knownUnitCount: 0,
};

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
 * The all-history, positive, actual acquisition aggregate per Product — the one
 * query behind both {@link loadProductPricing} and
 * {@link loadExactEffectivePrices}, so the two can never disagree about which
 * Expense rows count.
 */
const loadPricingAggregates = async (
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
  options: { wholeCatalog?: boolean },
): Promise<Map<ProductId, PricingAggregate>> => {
  const rows = await unwrapDb(db)
    .select({
      productId: expense.productId,
      knownCost: sql<number>`COALESCE(sum(${expense.cost}) FILTER (WHERE ${expense.productQuantity} IS NOT NULL), 0)::double precision`,
      knownExpenseCount: sql<number>`count(*) FILTER (WHERE ${expense.productQuantity} IS NOT NULL)::int`,
      unknownExpenseCount: sql<number>`count(*) FILTER (WHERE ${expense.productQuantity} IS NULL)::int`,
      // `abs`, because `productQuantity` is signed. The `cost > 0` filter below
      // already excludes discards, but it does not stop a sign error on an
      // acquisition row — and a negative `knownUnitCount` would divide the
      // derived unit price negative, which flows straight through
      // `InventoryEntry.valuation` into the location rollup.
      knownUnitCount: sql<number>`COALESCE(sum(abs(${expense.productQuantity})), 0)::int`,
    })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        eq(expense.future, false),
        eq(expense.lineKind, "principal"),
        gt(expense.cost, 0),
        isNotNull(expense.productId),
        options.wholeCatalog ? undefined : inArray(expense.productId, ids),
      ),
    )
    .groupBy(expense.productId);

  const aggregateById = new Map<ProductId, PricingAggregate>();
  for (const row of rows) {
    if (row.productId === null) continue;
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
 * `wholeCatalog` drops the `productId IN (...)` filter. Pass it only when
 * `products` already IS every live product: the returned map is still built
 * from `products`, so surplus aggregate rows are never looked up and the output
 * is identical either way. It exists because the coverage detector hands this
 * the entire catalog — 5,553 bind parameters at 13.7ms, where one unfiltered
 * HashAggregate over the same rows measures 6.7ms.
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
 * Product relations, so this join-shaped loader can run concurrently with that
 * relational fetch. Keep the Expense predicates identical to
 * {@link loadProductPricing}: only live, actual, positive acquisition rows
 * participate, while unknown quantities still contribute to partial coverage.
 */
export const loadProductPricingForIngredientIds = async (
  db: Database | DrizzleTransaction,
  ingredientIds: readonly IngredientId[],
): Promise<Map<ProductId, ProductPricing>> => {
  if (ingredientIds.length === 0) return new Map();

  const rows = await unwrapDb(db)
    .select({
      id: product.id,
      price: product.price,
      knownCost: sql<number>`COALESCE(sum(${expense.cost}) FILTER (WHERE ${expense.id} IS NOT NULL AND ${expense.productQuantity} IS NOT NULL), 0)::double precision`,
      knownExpenseCount: sql<number>`count(${expense.id}) FILTER (WHERE ${expense.productQuantity} IS NOT NULL)::int`,
      unknownExpenseCount: sql<number>`count(${expense.id}) FILTER (WHERE ${expense.productQuantity} IS NULL)::int`,
      // `abs` for the same reason as `loadProductPricing` — see the note there.
      knownUnitCount: sql<number>`COALESCE(sum(abs(${expense.productQuantity})), 0)::int`,
    })
    .from(product)
    .leftJoin(
      expense,
      and(
        eq(expense.productId, product.id),
        notDeleted(expense),
        eq(expense.future, false),
        eq(expense.lineKind, "principal"),
        gt(expense.cost, 0),
      ),
    )
    .where(
      and(
        notDeleted(product),
        inArray(product.ingredientId, [...ingredientIds]),
      ),
    )
    .groupBy(product.id, product.price);

  return new Map(
    rows.map((row) => [
      row.id,
      resolveProductPricing(row.price, {
        knownCost: Number(row.knownCost),
        knownExpenseCount: Number(row.knownExpenseCount),
        unknownExpenseCount: Number(row.unknownExpenseCount),
        knownUnitCount: Number(row.knownUnitCount),
      }),
    ]),
  );
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

/**
 * Correlated SQL used only by Product root-list filtering/sorting/aggregation.
 * `productAlias` must be the query's known SQL alias (RQB uses `product`).
 *
 * Keep the predicates and the `abs()` identical to {@link loadProductPricing} —
 * this is what the list sorts and filters by, and the loader is what the row
 * and the detail page display. A divergence here sorts by a number the user is
 * never shown.
 */
const derivedProductPriceSql = (productAlias = '"product"') =>
  `(SELECT round((sum(e."cost") / NULLIF(sum(abs(e."productQuantity")), 0))::numeric, 2)::double precision
    FROM "Expense" e
    WHERE e."productId" = ${productAlias}."id"
      AND e."deletedAt" IS NULL
      AND e."future" = false
      AND e."lineKind" = 'principal'
      AND e."cost" > 0
      AND e."productQuantity" IS NOT NULL)`;

export const effectiveProductPriceSql = (productAlias = '"product"') =>
  `COALESCE(${productAlias}."price", ${derivedProductPriceSql(productAlias)})`;
