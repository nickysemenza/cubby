import {
  type ProductId,
  productId,
  locationId,
} from "@cubby/schemas/identifiers";
import type {
  ProductPickerOnHandOut,
  ProductQuantityLedgerOut,
  ProductQuantitySummaryOut,
} from "@cubby/schemas/product";
import { productPrimaryPlacement } from "@cubby/schemas/product";
import { classifyProductOnHand } from "@cubby/schemas/product-read-fields";
import type { AnyColumn } from "drizzle-orm";
import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
/** Canonical read-time quantity ledger: known balance is acquired minus exited; unknown quantities stay explicit. */
import { actualExpenseSql } from "~/server/db/helpers/predicates";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { inventoryAmountSql } from "~/server/domains/inventory/repo/helpers";
import { loadLocationAncestors } from "~/server/domains/location/repo/tree";
import {
  kitAncestorCteSql,
  kitAncestorCteText,
  kitProjectionFrom,
  kitSeedForProductAlias,
  kitSeedForProductIds,
  ownOnly,
  projectionRows,
  unitWeighted,
} from "~/server/domains/product/repo/kit-projection";
import {
  serviceProductIdSql,
  serviceProductSqlText,
} from "~/server/domains/product/repo/service-category";
import type { QualityReadContext } from "~/server/generic/data-quality/repo/registry";
import { liveAliasSqlText } from "~/server/lib/live-row";
import {
  deriveProductQuantitySummary,
  hasComparableQuantityHistory,
} from "~/server/lib/product-quantity-summary";

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
const QUANTITY_OWN_MEASURES = `COALESCE(sum(GREATEST(${expenseSignedUnitsSql("kqe")}, 0)), 0) AS "acquiredUnits",
         COALESCE(sum(-LEAST(${expenseSignedUnitsSql("kqe")}, 0)), 0) AS "exitedUnits",
         count(*) FILTER (WHERE kqe."productQuantity" IS NULL AND (kqe."cost" IS NULL OR kqe."cost" >= 0)) AS "unknownAcquisitionLines",
         count(*) FILTER (WHERE kqe."productQuantity" IS NULL AND kqe."cost" < 0) AS "unknownExitLines",
         count(*) AS "ledgerLines"`;
const QUANTITY_OWN_PREDICATES = `NOT ${serviceProductSqlText('kqe."productId"')} AND ${liveAliasSqlText("kqe")} AND ${actualExpenseSql("kqe")}`;
const QUANTITY_OWN_AGGREGATE = `SELECT ${QUANTITY_OWN_MEASURES}
    FROM "Expense" kqe
   WHERE kqe."productId" = ka."productId" AND ${QUANTITY_OWN_PREDICATES}`;

const QUANTITY_PROJECTION_FROM = kitProjectionFrom(QUANTITY_OWN_AGGREGATE);

const PROJECTED_ACQUIRED = `CASE WHEN bool_or(${serviceProductSqlText("ka.target")}) THEN 0 ELSE ${unitWeighted('"acquiredUnits"')} END`;
const PROJECTED_EXITED = `CASE WHEN bool_or(${serviceProductSqlText("ka.target")}) THEN 0 ELSE ${unitWeighted('"exitedUnits"')} END`;
const PROJECTED_EXPECTED = `COALESCE(${PROJECTED_ACQUIRED} - ${PROJECTED_EXITED}, 0)::double precision`;
const PROJECTED_UNKNOWN_QUANTITY = `COALESCE(sum(ko."unknownAcquisitionLines") + sum(ko."unknownExitLines"), 0) > 0`;

/**
 * Catalog quantity filters share one kit walk and own ledger aggregation
 * before evaluating their measure for each target.
 */
const quantityMeasureReadSql = (value: SQL) => sql`${kitAncestorCteSql(
  kitSeedForProductIds([], true),
  { groupedSiblingQuantities: true },
)}, kit_own AS MATERIALIZED (
  SELECT kqe."productId", ${sql.raw(QUANTITY_OWN_MEASURES)}
  FROM "Expense" kqe
  WHERE ${sql.raw(QUANTITY_OWN_PREDICATES)}
  GROUP BY kqe."productId"
)
SELECT ka.target AS "id", ${value} AS "value"
FROM kit_anc ka LEFT JOIN kit_own ko ON ko."productId" = ka."productId"
GROUP BY ka.target`;
/** Every Product's expected balance as (id, value), matching expectedQuantitySql. */
export const expectedQuantityReadSql = () =>
  quantityMeasureReadSql(sql.raw(PROJECTED_EXPECTED));

/** Catalog quantity gaps reuse the same live ancestry and unknown-line counts. */
export const unknownQuantityLinesReadSql = () =>
  quantityMeasureReadSql(sql.raw(PROJECTED_UNKNOWN_QUANTITY));
const PROJECTED_COMPARABLE_HISTORY = `COALESCE(sum(ko."unknownAcquisitionLines") + sum(ko."unknownExitLines"), 0) = 0 AND COALESCE(${PROJECTED_ACQUIRED} + ${PROJECTED_EXITED}, 0) > 0`;
const comparableQuantityHistorySql = (productAlias = '"product"') =>
  `(${kitAncestorCteText(kitSeedForProductAlias(productAlias))} SELECT ${PROJECTED_COMPARABLE_HISTORY} ${QUANTITY_PROJECTION_FROM})`;

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

const onHandUnitsProjection = (
  inventoryCount = "ohu_inv.n",
  locationCount = "ohu_loc.n",
) => `CASE
             WHEN ${inventoryCount} = 0 AND ${locationCount} = 0 THEN NULL
             WHEN ohu_inv.noncount THEN NULL
             ELSE COALESCE(ohu_inv.qty, 0) + ${locationCount}
           END::double precision`;

/** Stock evidence stated once for the correlated (`onHandUnitsSql`,
 * `onHandUnitsFilterSql`) and grouped (`onHandUnitsReadSql`) forms; each
 * appends its own product condition. */
const ON_HAND_INVENTORY = `count(*) AS n,
                   bool_or(ohu_i."amountUnit" <> 'each') AS noncount,
                   sum(ohu_i."amountValue"::numeric) AS qty
              FROM "InventoryEntry" ohu_i
              JOIN "Location" ohu_l
                ON ohu_l."id" = ohu_i."locationId" AND ${liveAliasSqlText("ohu_l")}
             WHERE ${liveAliasSqlText("ohu_i")}`;
const ON_HAND_LOCATIONS = `count(*) AS n
              FROM "Location" ohu_ol
             WHERE ${liveAliasSqlText("ohu_ol")}`;

/** On-hand filters are null wherever the UI shows an unavailable value; include shelf and installed placements consistently. */
export const onHandUnitsSql = (productAlias = '"product"') =>
  `(SELECT CASE WHEN ${serviceProductSqlText(`${productAlias}."id"`)} THEN NULL ELSE ${onHandUnitsProjection()} END
      FROM (SELECT ${ON_HAND_INVENTORY}
               AND ohu_i."productId" = ${productAlias}."id") ohu_inv,
           (SELECT ${ON_HAND_LOCATIONS}
               AND ohu_ol."productId" = ${productAlias}."id") ohu_loc)`;

/** Broad callers opt into one stock relation; missing rows retain unavailable stock. */
export const onHandUnitsReadSql = () => sql`
  SELECT COALESCE(ohu_inv."productId", ohu_loc."productId") AS "productId",
    CASE WHEN ${sql.raw(serviceProductSqlText('COALESCE(ohu_inv."productId", ohu_loc."productId")'))} THEN NULL ELSE ${sql.raw(onHandUnitsProjection("COALESCE(ohu_inv.n, 0)", "COALESCE(ohu_loc.n, 0)"))} END AS "onHandUnits"
  FROM (
    SELECT ohu_i."productId", ${sql.raw(ON_HAND_INVENTORY)}
    GROUP BY ohu_i."productId"
  ) ohu_inv FULL JOIN (
    SELECT ohu_ol."productId", ${sql.raw(ON_HAND_LOCATIONS)}
      AND ohu_ol."productId" IS NOT NULL GROUP BY ohu_ol."productId"
  ) ohu_loc ON ohu_inv."productId" = ohu_loc."productId"`;

/**
 * Shelf minus ledger. Zero means the two agree; a product with no inventory and
 * no ledger is trivially zero, which is why the *filters* pair this with an
 * "is stocked" predicate rather than treating every untouched product as
 * reconciled.
 *
 * includes-installed: inherited from `onHandUnitsSql` — see that doc.
 */
export const quantityVarianceSql = (productAlias = '"product"') =>
  `(CASE WHEN ${comparableQuantityHistorySql(productAlias)} THEN ${onHandUnitsSql(productAlias)} - ${expectedQuantitySql(productAlias)} END)`;

/** Shared SQL fragments for product-list filters; interpolate product.id rather than a hand-qualified alias. */
export const expectedQuantityFilterSql = (productId: AnyColumn) =>
  sql`(${kitAncestorCteSql(
    sql`SELECT ${productId}, ${productId}, 1::numeric, 1::numeric, 0`,
  )}
      SELECT ${sql.raw(PROJECTED_EXPECTED)}
      ${sql.raw(QUANTITY_PROJECTION_FROM)})`;

export const onHandUnitsFilterSql = (
  productId: AnyColumn,
  context?: QualityReadContext,
) =>
  context?.derivedValue?.("onHandUnits", productId) ??
  sql`(SELECT CASE WHEN ${serviceProductIdSql(sql`${productId}`)} THEN NULL ELSE ${sql.raw(onHandUnitsProjection())} END
         FROM (SELECT ${sql.raw(ON_HAND_INVENTORY)}
                  AND ohu_i."productId" = ${productId}) ohu_inv,
              (SELECT ${sql.raw(ON_HAND_LOCATIONS)}
                  AND ohu_ol."productId" = ${productId}) ohu_loc)`;

/** Quantity gaps include inherited kit lines, matching the displayed ledger. */
export const hasUnknownQuantityLinesSql = (productId: AnyColumn) =>
  sql`(${kitAncestorCteSql(sql`SELECT ${productId}, ${productId}, 1::numeric, 1::numeric, 0`)}
    SELECT ${sql.raw(PROJECTED_UNKNOWN_QUANTITY)}
    ${sql.raw(QUANTITY_PROJECTION_FROM)})`;

/** An unknown acquisition anywhere in the kit ancestry keeps disposal uncertain. */
export const hasUnknownAcquisitionLinesSql = (productId: AnyColumn) =>
  sql`(${kitAncestorCteSql(sql`SELECT ${productId}, ${productId}, 1::numeric, 1::numeric, 0`)}
    SELECT COALESCE(sum(ko."unknownAcquisitionLines"), 0) > 0
    ${sql.raw(QUANTITY_PROJECTION_FROM)})`;

const ownershipQuantityEvidenceRow = z.object({
  productId,
  ownExpectedQuantity: z.number(),
  hasKitContributions: z.boolean(),
});

/** Direct intervals can only be compared with the direct Expense balance.
 * Ancestor evidence, including quantity-less lines, keeps ownership uncertain
 * until the ownership fold also models kit history. */
export const loadProductOwnershipQuantityEvidence = async (
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
) => {
  if (ids.length === 0)
    return new Map<ProductId, z.infer<typeof ownershipQuantityEvidenceRow>>();
  const query = sql`${kitAncestorCteSql(kitSeedForProductIds(ids))}
    SELECT ka.target AS "productId",
           COALESCE(${sql.raw(ownOnly(`"acquiredUnits"`))} - ${sql.raw(ownOnly(`"exitedUnits"`))}, 0)::double precision AS "ownExpectedQuantity",
           COALESCE(bool_or(ka.depth > 0 AND ko."ledgerLines" > 0), false) AS "hasKitContributions"
      ${sql.raw(QUANTITY_PROJECTION_FROM)}
     GROUP BY ka.target`;
  const rows = projectionRows(
    await unwrapDb(db).execute(query),
    ownershipQuantityEvidenceRow,
  );
  return new Map(rows.map((row) => [row.productId, row]));
};

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
           COALESCE(${sql.raw(`sum(ko."unknownAcquisitionLines")`)}, 0)::int AS "unknownAcquisitionLines",
           COALESCE(${sql.raw(`sum(ko."unknownExitLines")`)}, 0)::int AS "unknownExitLines",
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
             COALESCE(${sql.raw(`sum(ko."unknownAcquisitionLines")`)}, 0)::int AS "unknownAcquisitionLines",
             COALESCE(${sql.raw(`sum(ko."unknownExitLines")`)}, 0)::int AS "unknownExitLines",
             COALESCE(sum(ko."ledgerLines"), 0)::int AS "ledgerLines"
        ${sql.raw(QUANTITY_PROJECTION_FROM)}
       GROUP BY ka.target
    ),
    location_counts AS (
      SELECT l."productId", count(*)::int AS "locationCount"
        FROM "Location" l
       WHERE ${notDeleted("l")}
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

const placementRowSchema = z.object({
  productId,
  locationId,
  shortcode: z.string(),
  name: z.string(),
  onHand: z.number(),
  onHandUnits: z.number().nullable(),
});

/** One bounded stock aggregate and one ancestor batch for the whole page.
 * Identity Locations count as one owned unit, as in onHandUnitsReadSql.
 * Activity breaks quantity ties; the public code makes exact ties stable. */
export const loadProductPlacementFacts = async (
  db: Database,
  ids: readonly ProductId[],
): Promise<
  Map<
    ProductId,
    {
      primaryPlacement: z.infer<typeof productPrimaryPlacement>;
      onHandUnits: number | null;
    }
  >
> => {
  if (ids.length === 0) return new Map();
  const stockInventory = alias(inventoryEntry, "i");
  const stockLocation = alias(location, "l");
  const stockProduct = alias(product, "p");
  const rows = projectionRows(
    await unwrapDb(db).execute(sql`
    WITH stock AS (
      SELECT i."productId", i."locationId", i."amountValue"::double precision AS quantity,
        i."amountUnit" <> 'each' AS noncount, i."updatedAt" AS activity
      FROM "InventoryEntry" i
      JOIN "Location" l ON l.id = i."locationId" AND ${notDeleted(stockLocation)}
      WHERE ${notDeleted(stockInventory)} AND i."productId" = ANY(${uuidArrayParam(ids)})
      UNION ALL
      SELECT l."productId", l.id, 1::double precision, false, l."updatedAt"
      FROM "Location" l
      WHERE ${notDeleted(stockLocation)} AND l."productId" = ANY(${uuidArrayParam(ids)})
    ), places AS (
      SELECT "productId", "locationId", sum(quantity) AS "onHand",
        bool_or(noncount) AS noncount, max(activity) AS activity
      FROM stock GROUP BY "productId", "locationId"
    ), ranked AS (
      SELECT places.*, l.shortcode, l.name,
        CASE WHEN bool_or(noncount) OVER (PARTITION BY places."productId") THEN NULL
          ELSE sum("onHand") OVER (PARTITION BY places."productId") END AS "onHandUnits",
        row_number() OVER (PARTITION BY places."productId"
          ORDER BY "onHand" DESC, activity DESC, l.shortcode) AS rank
      FROM places JOIN "Location" l ON l.id = places."locationId"
      JOIN "Product" p ON p.id = places."productId" AND ${notDeleted(stockProduct)}
      WHERE NOT ${serviceProductIdSql(sql`p.id`)}
    )
    SELECT "productId", "locationId", shortcode, name, "onHand", "onHandUnits"
    FROM ranked WHERE rank = 1
  `),
    placementRowSchema,
  );
  const ancestors = await loadLocationAncestors(
    db,
    rows.map((row) => row.locationId),
  );
  return new Map(
    rows.map((row) => [
      row.productId,
      {
        primaryPlacement: {
          locationId: row.shortcode,
          path: [
            ...(ancestors.get(row.locationId) ?? []).map((rung) => rung.name),
            row.name,
          ].join(" › "),
          onHand: row.onHand,
        },
        onHandUnits: row.onHandUnits,
      },
    ]),
  );
};

/**
 * Attach the ledger to loaded rows. A product with no product-linked Expense
 * gets the empty ledger rather than null. Its zero is a numeric identity,
 * not evidence that nothing is owned; presence explanations retain that distinction.
 */
export const enrichProductRowsWithQuantityLedger = async <
  T extends { id: ProductId },
>(
  db: Database,
  products: readonly T[],
): Promise<
  Array<
    T & {
      quantityLedger: QuantityLedger;
      primaryPlacement: z.infer<typeof productPrimaryPlacement> | null;
    }
  >
> => {
  const placements = await loadProductPlacementFacts(
    db,
    products.map((product) => product.id),
  );
  const ledgers = await loadProductQuantityLedgers(
    db,
    products.map((product) => product.id),
  );
  return products.map((product) => ({
    ...product,
    quantityLedger: ledgers.get(product.id) ?? EMPTY_QUANTITY_LEDGER,
    primaryPlacement: placements.get(product.id)?.primaryPlacement ?? null,
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
  const services = new Set(
    (
      await unwrapDb(db)
        .select({ id: product.id })
        .from(product)
        .where(
          and(
            inArray(product.id, [...ids]),
            notDeleted(product),
            serviceProductIdSql(sql`${product.id}`),
          ),
        )
    ).map((row) => row.id),
  );
  const inventoryRows = await unwrapDb(db)
    .select({
      productId: inventoryEntry.productId,
      amount: inventoryAmountSql,
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
    if (services.has(id)) {
      quantities.set(id, {
        quantityLedger: ledgers.get(id) ?? EMPTY_QUANTITY_LEDGER,
        onHand: { state: "none" },
      });
      continue;
    }
    const quantityLedger = ledgers.get(id) ?? EMPTY_QUANTITY_LEDGER;
    const amounts = amountsByProduct.get(id) ?? [];
    const summary = deriveProductQuantitySummary(
      amounts.map((amount) => ({ amount })),
      quantityLedger,
    );
    const onHand = classifyProductOnHand({
      units: summary.onHandUnits,
      inventoryCount: amounts.length,
      locationCount: quantityLedger.locationCount,
    });

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
        onHandUnits === null || !hasComparableQuantityHistory(quantityLedger)
          ? null
          : onHandUnits - quantityLedger.expectedQuantity,
    });
  }

  return summaries;
};
