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
 * Resolve the public pricing contract from the manual override and the live
 * Expense aggregate. Historical money never lands on Product: the aggregate is
 * rebuilt from Expense whenever a caller needs it.
 */
export const resolveProductPricing = (
  explicitPrice: number | null,
  aggregate: PricingAggregate = EMPTY_AGGREGATE,
): ProductPricing => {
  const derivedPrice =
    aggregate.knownUnitCount > 0
      ? Math.round((aggregate.knownCost / aggregate.knownUnitCount) * 100) / 100
      : null;
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

/** Batch-load the all-history, positive, actual acquisition aggregate. */
export const loadProductPricing = async (
  db: Database | DrizzleTransaction,
  products: ReadonlyArray<{ id: ProductId; price: number | null }>,
): Promise<Map<ProductId, ProductPricing>> => {
  const ids = products.map((product) => product.id);
  if (ids.length === 0) return new Map();

  const rows = await unwrapDb(db)
    .select({
      productId: expense.productId,
      knownCost: sql<number>`COALESCE(sum(${expense.cost}) FILTER (WHERE ${expense.productQuantity} IS NOT NULL), 0)::double precision`,
      knownExpenseCount: sql<number>`count(*) FILTER (WHERE ${expense.productQuantity} IS NOT NULL)::int`,
      unknownExpenseCount: sql<number>`count(*) FILTER (WHERE ${expense.productQuantity} IS NULL)::int`,
      knownUnitCount: sql<number>`COALESCE(sum(${expense.productQuantity}), 0)::int`,
    })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        eq(expense.future, false),
        gt(expense.cost, 0),
        isNotNull(expense.productId),
        inArray(expense.productId, ids),
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

  return new Map(
    products.map((product) => [
      product.id,
      resolveProductPricing(product.price, aggregateById.get(product.id)),
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

/** Load one Product's effective price without materializing historical money. */
export const loadEffectiveProductPrice = async (
  db: Database | DrizzleTransaction,
  product: { id: ProductId; price: number | null },
): Promise<number | null> =>
  (await loadProductPricing(db, [product])).get(product.id)?.effectivePrice ??
  null;

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
 */
const derivedProductPriceSql = (productAlias = '"product"') =>
  `(SELECT round((sum(e."cost") / NULLIF(sum(e."productQuantity"), 0))::numeric, 2)::double precision
    FROM "Expense" e
    WHERE e."productId" = ${productAlias}."id"
      AND e."deletedAt" IS NULL
      AND e."future" = false
      AND e."cost" > 0
      AND e."productQuantity" IS NOT NULL)`;

export const effectiveProductPriceSql = (productAlias = '"product"') =>
  `COALESCE(${productAlias}."price", ${derivedProductPriceSql(productAlias)})`;
