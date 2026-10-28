import type { FieldResolution } from "@cubby/schemas/field-resolution";
import {
  type IngredientId,
  type ProductId,
  productId,
} from "@cubby/schemas/identifiers";
import { isServiceProductCategory } from "@cubby/schemas/product-category-fields";
import type { RawProductOutput } from "@cubby/schemas/product-raw-read";
import { round2 } from "@cubby/shared";
import { and, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { formatCurrency } from "~/lib/number-format";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  getDb,
  notDeleted,
  unwrapDb,
  uuidArrayParam,
} from "~/server/db/helpers";
import { actualExpenseSql } from "~/server/db/helpers/predicates";
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
import { serviceProductSqlText } from "~/server/domains/product/repo/service-category";
import {
  storedDerivedSql,
  type StoredDerivedRead,
} from "~/server/generic/derived/repo/read";
import { liveAliasSqlText } from "~/server/lib/live-row";

export type ProductPricing = RawProductOutput["pricing"];

export type PricingAggregate = Omit<
  z.infer<typeof pricingAggregateRowSchema>,
  "productId"
>;

const EMPTY_AGGREGATE: PricingAggregate = {
  service: false,
  knownCost: 0,
  knownExpenseCount: 0,
  unknownExpenseCount: 0,
  knownUnitCount: 0,
};

const pricingAggregateRowSchema = z.object({
  productId,
  service: z.boolean().optional(),
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
  const derivedPrice = aggregate.service
    ? null
    : roundOrNull(derivedPriceExact(aggregate));
  const effectivePrice = aggregate.service
    ? null
    : (explicitPrice ?? derivedPrice);
  return {
    cost: {
      amount: effectivePrice,
      label: effectivePrice === null ? null : formatCurrency(effectivePrice),
      explanation:
        "Item cost uses the manual valuation price when set, otherwise the Expense-derived unit price.",
      chargeCount: 0,
      latestCharge: null,
    },
    derivedPrice,
    effectivePrice,
    source:
      explicitPrice !== null && !aggregate.service
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
  service = false,
): FieldResolution => ({
  mode: storedPrice !== null ? "explicit" : "inherit",
  storedValue: storedPrice,
  value: pricing.effectivePrice,
  assignmentAllowed: !service,
  ...(service ? { emptyReason: "not_applicable" as const } : {}),
  fallbackValue: pricing.derivedPrice,
  source: service
    ? "not applicable to services"
    : storedPrice !== null
      ? "manual valuation price"
      : pricing.derivedPrice !== null
        ? "expense-derived unit price"
        : "no valuation price",
  // The fallback aggregates live Expense history, including kit shares; it
  // cannot honestly point at one Expense or Purchase as its source record.
  sourceEntity: null,
  matchesFallback: storedPrice !== null && storedPrice === pricing.derivedPrice,
  canReset: !service && storedPrice !== null,
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

const PRICING_OWN_PREDICATES = `NOT ${serviceProductSqlText('kpe."productId"')}
     AND ${liveAliasSqlText("kpe")}
     AND ${actualExpenseSql("kpe")}
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
           ${sql.raw(serviceProductSqlText("ka.target"))} AS "service",
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
      service: row.service,
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

  const [aggregateById, charges] = await Promise.all([
    loadPricingAggregates(db, ids, options),
    unwrapDb(db).execute(sql`
      SELECT p."id" AS "productId",
        avg(e."cost") FILTER (WHERE e."cost" > 0)::double precision AS average,
        count(*) FILTER (WHERE e."cost" > 0)::int AS count,
        (array_agg(e."cost" ORDER BY e."date" DESC, e."id" DESC)
          FILTER (WHERE e."cost" > 0 AND e."date" IS NOT NULL))[1]::double precision AS latest
      FROM "Product" p
      LEFT JOIN "Expense" e ON e."productId" = p."id"
        AND ${notDeleted("e")} AND ${sql.raw(actualExpenseSql("e"))}
      WHERE p."id" = ANY(${uuidArrayParam(ids)})
        AND ${sql.raw(serviceProductSqlText('p."id"'))}
      GROUP BY p."id"
    `),
  ]);
  const chargeRows = z
    .array(
      z.object({
        productId,
        average: z.number().nullable(),
        count: z.number(),
        latest: z.number().nullable(),
      }),
    )
    .parse(charges.rows);
  const chargeById = new Map(chargeRows.map((row) => [row.productId, row]));
  return new Map(
    products.map((product) => {
      const pricing = resolveProductPricing(
        product.price,
        aggregateById.get(product.id),
      );
      const charge = chargeById.get(product.id);
      if (charge) {
        const average = roundOrNull(charge.average);
        pricing.cost = {
          amount: average,
          label:
            average === null ? null : `${formatCurrency(average)} / charge`,
          explanation:
            "Average of positive actual Expense charges. Credits and unknown amounts are excluded. Charges may cover different periods, usage, or seats; this is not a monthly rate.",
          chargeCount: charge.count,
          latestCharge: charge.latest,
        };
      }
      return [product.id, pricing] satisfies [ProductId, ProductPricing];
    }),
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
      aggregateById.get(product.id)?.service
        ? null
        : (product.price ??
          derivedPriceExact(aggregateById.get(product.id) ?? EMPTY_AGGREGATE)),
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

/** Divide, round to cents — shared by the sort twin and the filter twin below. */
const PROJECTED_DERIVED_PRICE = `CASE WHEN bool_or(${serviceProductSqlText("ka.target")}) THEN NULL ELSE round((${PROJECTED_KNOWN_COST} / NULLIF(${PROJECTED_KNOWN_UNITS}, 0))::numeric, 2)::double precision END`;

/**
 * Correlated SQL for Product root-list sorting and aggregation.
 * `productAlias` must be the query's
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
  `(CASE WHEN NOT ${serviceProductSqlText(`${productAlias}."id"`)} THEN COALESCE(${productAlias}."price", ${derivedProductPriceSql(productAlias)}) END)`;

/** One read precedence for the value, filters, sorting and filtered totals. */
export const productReadPriceSql: SQL = sql`CASE WHEN NOT ${sql.raw(serviceProductSqlText('"Product"."id"'))} THEN ${storedDerivedSql(
  "product",
  "price",
  product.id,
  { currentAssignment: sql`${product.price}` },
)} END`;

/** Cost sorting selects the same service snapshot or physical valuation as display. */
export const productReadCostSql: SQL = sql`CASE WHEN ${sql.raw(serviceProductSqlText('"Product"."id"'))}
  THEN ${storedDerivedSql("product", "cost", product.id)} ELSE ${productReadPriceSql} END`;

const productPriceSumSql = (whereClause: SQL | undefined): SQL<number> => sql`
  SELECT COALESCE(sum((${productReadPriceSql})::numeric), 0)::double precision AS "priceSum"
  FROM "Product" WHERE ${whereClause ?? sql`TRUE`}
    AND NOT ${sql.raw(serviceProductSqlText('"Product"."id"'))}`;

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

/** Inventory embeds use the same immediate override and reset rules as Product reads. */
export function storedEffectivePrice(
  stored: ReadonlyMap<string, ReadonlyMap<string, StoredDerivedRead>>,
  row: Pick<typeof product.$inferSelect, "id" | "price"> &
    Pick<RawProductOutput, "category">,
): number | null {
  if (isServiceProductCategory(row.category)) return null;
  if (row.price !== null)
    return resolveProductPricing(row.price).effectivePrice;
  const read = stored.get(row.id)?.get("price");
  return read?.resultExists &&
    read.decision?.provenance &&
    read.decision.provenance.kind !== "own"
    ? z.number().nullable().parse(read.value)
    : null;
}
