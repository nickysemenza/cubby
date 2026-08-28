/** Canonical read-time quantity ledger: known balance is acquired minus exited; unknown quantities stay explicit. */
import { type ProductId, productId } from "@cubby/schemas/identifiers";
import type {
  ProductPickerOnHandOut,
  ProductQuantityLedgerOut,
  ProductQuantitySummaryOut,
} from "@cubby/schemas/product";
import type { AnyColumn } from "drizzle-orm";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { inventoryEntry, location } from "~/server/db/schema";
import {
  notDeleted,
  unwrapDb,
  uuidArrayParam,
} from "~/server/repo/database-helpers";
import {
  kitAncestorCteSql,
  kitAncestorCteText,
  kitProjectionFrom,
  kitSeedForProductAlias,
  kitSeedForProductIds,
  ownOnly,
  projectionRows,
  unitWeighted,
} from "~/server/repo/product/kit-projection";

export type QuantityLedger = ProductQuantityLedgerOut;

export const EMPTY_QUANTITY_LEDGER: QuantityLedger = {
  acquiredUnits: 0,
  exitedUnits: 0,
  expectedQuantity: 0,
  unknownAcquisitionLines: 0,
  unknownExitLines: 0,
  locationCount: 0,
};

const projectedQuantityRowSchema = z.object({
  productId,
  acquiredUnits: z.number(),
  exitedUnits: z.number(),
  unknownAcquisitionLines: z.number().int(),
  unknownExitLines: z.number().int(),
  ledgerLines: z.number().int(),
});

/** Shared signed per-line SQL contribution; derive all ledger aggregates from this expression. */
const expenseSignedUnitsSql = (alias: string) =>
  `CASE WHEN ${alias}."cost" > 0 THEN abs(${alias}."productQuantity")
        WHEN ${alias}."cost" < 0 THEN -abs(${alias}."productQuantity")
        ELSE ${alias}."productQuantity"
   END`;

/** Own ledger contributions use signed known quantities only; kit projection is intentionally excluded. */
const QUANTITY_OWN_AGGREGATE = `SELECT COALESCE(sum(GREATEST(${expenseSignedUnitsSql("kqe")}, 0)), 0) AS "acquiredUnits",
         COALESCE(sum(-LEAST(${expenseSignedUnitsSql("kqe")}, 0)), 0) AS "exitedUnits",
         count(*) FILTER (WHERE kqe."productQuantity" IS NULL AND (kqe."cost" IS NULL OR kqe."cost" >= 0)) AS "unknownAcquisitionLines",
         count(*) FILTER (WHERE kqe."productQuantity" IS NULL AND kqe."cost" < 0) AS "unknownExitLines",
         count(*) AS "ledgerLines"
    FROM "Expense" kqe
   WHERE kqe."productId" = ka."productId"
     AND kqe."deletedAt" IS NULL
     AND kqe."future" = false`;

const QUANTITY_PROJECTION_FROM = kitProjectionFrom(QUANTITY_OWN_AGGREGATE);

const PROJECTED_ACQUIRED = unitWeighted(`"acquiredUnits"`);
const PROJECTED_EXITED = unitWeighted(`"exitedUnits"`);
const PROJECTED_EXPECTED = `COALESCE(${PROJECTED_ACQUIRED} - ${PROJECTED_EXITED}, 0)::double precision`;

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
  `(${kitAncestorCteText(kitSeedForProductAlias(productAlias))}
    SELECT ${PROJECTED_EXPECTED}
    ${QUANTITY_PROJECTION_FROM})`;

/** On-hand filters are null wherever the UI shows an unavailable value; include shelf and installed placements consistently. */
export const onHandUnitsSql = (productAlias = '"product"') =>
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

/** Shared SQL fragments for product-list filters; interpolate product.id rather than a hand-qualified alias. */
export const expectedQuantityFilterSql = (productId: AnyColumn) =>
  sql`(${kitAncestorCteSql(
    sql`SELECT ${productId}, ${productId}, 1::numeric, 1::numeric, 0`,
  )}
      SELECT ${sql.raw(PROJECTED_EXPECTED)}
      ${sql.raw(QUANTITY_PROJECTION_FROM)})`;

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

/** Does this product carry an acquisition whose quantity is unknown? */
export const hasUnknownAcquisitionLinesSql = (productId: AnyColumn) =>
  sql`EXISTS (SELECT 1 FROM "Expense" uaq_e
               WHERE uaq_e."productId" = ${productId}
                 AND uaq_e."deletedAt" IS NULL
                 AND uaq_e."future" = false
                 AND uaq_e."productQuantity" IS NULL
                 AND (uaq_e."cost" IS NULL OR uaq_e."cost" >= 0))`;

/**
 * Batch-load the quantity ledger for a page of products.
 *
 * Two queries: the projected Expense ledger, then the location count. A join
 * would multiply the already-grouped first aggregate by the second's
 * one-to-many.
 */
export const loadProductQuantityLedgers = async (
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
): Promise<Map<ProductId, QuantityLedger>> => {
  if (ids.length === 0) return new Map();

  const query = sql`${kitAncestorCteSql(kitSeedForProductIds(ids))}
    SELECT ka.target AS "productId",
           COALESCE(${sql.raw(PROJECTED_ACQUIRED)}, 0)::double precision AS "acquiredUnits",
           COALESCE(${sql.raw(PROJECTED_EXITED)}, 0)::double precision AS "exitedUnits",
           COALESCE(${sql.raw(ownOnly(`"unknownAcquisitionLines"`))}, 0)::int AS "unknownAcquisitionLines",
           COALESCE(${sql.raw(ownOnly(`"unknownExitLines"`))}, 0)::int AS "unknownExitLines",
           COALESCE(sum(ko."ledgerLines"), 0)::int AS "ledgerLines"
      ${sql.raw(QUANTITY_PROJECTION_FROM)}
     GROUP BY ka.target`;

  const rows = projectionRows(
    await unwrapDb(db).execute(query),
    projectedQuantityRowSchema,
  );

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
    // Absence still means "no ledger at all", the way the grouped query this
    // replaced did — the seed produces a row per requested product whether or
    // not any Expense matched, so the line count is what tells the two apart.
    // A genuine net-zero product (bought five, returned five) keeps its row, and
    // so does a component whose only lines are its kit's.
    if (Number(row.ledgerLines) === 0) continue;
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

type QuantityLedgerAggregateRow = {
  productId: ProductId;
  acquiredUnits: number;
  exitedUnits: number;
  unknownAcquisitionLines: number;
  unknownExitLines: number;
  ledgerLines: number;
  locationCount: number;
};

const quantityLedgerAggregateRowSchema = projectedQuantityRowSchema.extend({
  locationCount: z.number().int(),
});

const quantityLedgersFromAggregateRows = (
  rows: readonly QuantityLedgerAggregateRow[],
): Map<ProductId, QuantityLedger> => {
  const byProduct = new Map<ProductId, QuantityLedger>();
  for (const row of rows) {
    const ledgerLines = Number(row.ledgerLines);
    const locationCount = Number(row.locationCount);
    // The seed emits one row even when there are no Expense lines. Preserve the
    // existing empty-product behavior, while retaining a row for a product that
    // is represented by a live Location rather than an Expense.
    if (ledgerLines === 0 && locationCount === 0) continue;
    const acquiredUnits = Number(row.acquiredUnits);
    const exitedUnits = Number(row.exitedUnits);
    byProduct.set(row.productId, {
      acquiredUnits,
      exitedUnits,
      expectedQuantity: acquiredUnits - exitedUnits,
      unknownAcquisitionLines: Number(row.unknownAcquisitionLines),
      unknownExitLines: Number(row.unknownExitLines),
      locationCount,
    });
  }
  return byProduct;
};

/**
 * Detail-only quantity read: keep the Expense projection and Location count as
 * separate aggregates, then join their one-row-per-product results. The public
 * batch loader above remains two statements because its callers may be inside a
 * transaction; this read-only Database path can remove one network round trip
 * without multiplying the Expense aggregate by the Location relation.
 */
export const loadProductDetailQuantityLedgers = async (
  db: Database,
  ids: readonly ProductId[],
): Promise<Map<ProductId, QuantityLedger>> => {
  if (ids.length === 0) return new Map();

  const query = sql`${kitAncestorCteSql(kitSeedForProductIds(ids))},
    quantity_ledger AS (
      SELECT ka.target AS "productId",
             COALESCE(${sql.raw(PROJECTED_ACQUIRED)}, 0)::double precision AS "acquiredUnits",
             COALESCE(${sql.raw(PROJECTED_EXITED)}, 0)::double precision AS "exitedUnits",
             COALESCE(${sql.raw(ownOnly(`"unknownAcquisitionLines"`))}, 0)::int AS "unknownAcquisitionLines",
             COALESCE(${sql.raw(ownOnly(`"unknownExitLines"`))}, 0)::int AS "unknownExitLines",
             COALESCE(sum(ko."ledgerLines"), 0)::int AS "ledgerLines"
        ${sql.raw(QUANTITY_PROJECTION_FROM)}
       GROUP BY ka.target
    ),
    location_counts AS (
      SELECT l."productId", count(*)::int AS "locationCount"
        FROM "Location" l
       WHERE l."deletedAt" IS NULL
         AND l."productId" = ANY(${uuidArrayParam(ids)})
       GROUP BY l."productId"
    )
    SELECT q."productId",
           q."acquiredUnits",
           q."exitedUnits",
           q."unknownAcquisitionLines",
           q."unknownExitLines",
           q."ledgerLines",
           COALESCE(l."locationCount", 0)::int AS "locationCount"
      FROM quantity_ledger q
      LEFT JOIN location_counts l ON l."productId" = q."productId"`;

  const rows = projectionRows(
    await unwrapDb(db).execute(query),
    quantityLedgerAggregateRowSchema,
  );
  return quantityLedgersFromAggregateRows(rows);
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

/**
 * Bounded batch of the same three quantity values the product list renders.
 *
 * This deliberately builds on `loadProductPickerQuantities`: that loader owns
 * the live-location, identity-location, and mixed-unit rules for on-hand
 * quantity, so a recount cannot silently use a different interpretation.
 */
export const loadProductQuantitySummaries = async (
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
): Promise<Map<ProductId, ProductQuantitySummaryOut>> => {
  const pickerQuantities = await loadProductPickerQuantities(db, ids);
  const summaries = new Map<ProductId, ProductQuantitySummaryOut>();

  for (const [id, { quantityLedger, onHand }] of pickerQuantities) {
    const onHandUnits = onHand.state === "counted" ? onHand.units : null;
    summaries.set(id, {
      quantityLedger,
      onHandUnits,
      quantityVariance:
        onHandUnits === null
          ? null
          : onHandUnits - quantityLedger.expectedQuantity,
    });
  }

  return summaries;
};
