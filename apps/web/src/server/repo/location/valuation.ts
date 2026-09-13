/**
 * Location valuation — computed on read.
 *
 * There is no persisted rollup: `computeLocationValuations` re-derives the
 * whole tree's valuation (a few hundred rows; milliseconds) from live
 * inventory + location data, via the pure rollup in
 * `services/location-valuation-rollup`. `directValuationSql` is the SQL-level
 * equivalent of one location's `directValuation` — usable directly in a
 * WHERE/ORDER BY on the `location` table — for the list filter/sort, which
 * has no whole-tree rollup to read from.
 */

import { type LocationId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  LocationValuation,
  LocationValuationSummaryOut,
} from "@cubby/schemas/location";
import { and, desc, eq, gt, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { getDb, notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";
import { rollupLocationValuations } from "~/server/services/location-valuation-rollup";

interface ValuationInventoryRow {
  locationId: LocationId;
  valuation: number | null;
  /** Fixtures roll up apart from countable stock — the rollup splits on this. */
  placement: "stock" | "installed";
  productName: string;
}

interface ValuationLocationRow {
  id: LocationId;
  parentId: LocationId | null;
  /**
   * Effective price of the SKU this location IS — the vessel's own worth,
   * which rolls into its PARENT's container bucket rather than its own
   * contents value. Null for rooms, areas and anything unlinked.
   */
  productPrice: number | null;
}

/**
 * SQL-level twin of the pure rollup's `directValuation`: the sum of positive
 * valuations of `stock`-placement entries at a location. `correlatedLocationId`
 * is the enclosing row's `location.id` — the ONE thing that must adapt to
 * whichever query this gets embedded in — and everything touching
 * `InventoryEntry`/`Product` is hand-written literal SQL instead of typed
 * column refs.
 *
 * That split isn't style: `locationList`'s `where`/`orderBy` go through
 * `db.query.location.findMany`, whose relational-query layer rewrites every
 * embedded `Column` chunk it finds to point at the PRIMARY table's own alias,
 * regardless of which table the column actually belongs to. A typed
 * `${inventoryEntry.valuation}` here silently became `"location"."valuation"`
 * and every other foreign-table column suffered the same fate — a runtime
 * `column location.valuation does not exist`, invisible to typecheck.
 *
 * Deliberately mirrors `loadLocationValuationInputs`'s entries join exactly:
 * that join does NOT filter `notDeleted(product)`, so this doesn't either —
 * the two must agree on population or a location's list-page valuation could
 * disagree with its detail-page rollup.
 */
const directValuationSubquery = (
  correlatedLocationId: SQL | AnyPgColumn,
) => sql<number>`COALESCE((
  SELECT SUM(ie.valuation)
  FROM "InventoryEntry" ie
  INNER JOIN "Product" p ON p.id = ie."productId"
  WHERE ie."locationId" = ${correlatedLocationId}
    AND ie."deletedAt" IS NULL
    AND ie.placement = 'stock'
    AND ie.valuation > 0
), 0)`;

/**
 * The `locationList` filter/sort variant: a typed `${location.id}` reference,
 * which survives the relational-query rewrite above unharmed (it already IS
 * the primary table) and also resolves correctly in `countWhere`'s bare
 * `$count(location, ...)`, since `locationList`'s `where` feeds both.
 */
export const directValuationSql = directValuationSubquery(location.id);

/**
 * The plain-select variant, for `getLocationValuationSummary` below: that
 * query addresses `location` by its real, unaliased name throughout — EXCEPT
 * in a `.select({...})` projection's value position, where a typed
 * `${location.id}` reference silently compiles bare (no table qualifier at
 * all), which is ambiguous inside this subquery's own `ie`/`p` scope (both
 * have an `id` column). A hardcoded, always-qualified literal sidesteps that
 * qualification quirk entirely.
 */
const directValuationSqlOnLocationTable = directValuationSubquery(
  sql.raw(`"Location"."id"`),
);

/** One compact SQL read for Home; no tree or relation hydration. */
export const getLocationValuationSummary = async (
  db: Database,
): Promise<LocationValuationSummaryOut> => {
  const rows = await getDb(db)
    .select({
      id: location.shortcode,
      name: location.name,
      value: directValuationSqlOnLocationTable,
      total: sql<number>`SUM(${directValuationSqlOnLocationTable}) OVER ()`,
    })
    .from(location)
    .where(and(notDeleted(location), gt(directValuationSqlOnLocationTable, 0)))
    .orderBy(desc(directValuationSqlOnLocationTable), location.name)
    .limit(5);

  return {
    total: Number(rows[0]?.total ?? 0),
    locations: rows.map((row) => ({
      id: parseShortcodeFor("location", row.id),
      name: row.name,
      value: Number(row.value),
    })),
  };
};

/**
 * Read the inputs for a whole-tree valuation compute: every non-deleted
 * inventory item (location, valuation, product name) and every non-deleted
 * location (id, parentId, and the price of the SKU it is).
 */
export const loadLocationValuationInputs = async (
  db: Database | DrizzleTransaction,
): Promise<{
  entries: ValuationInventoryRow[];
  locations: ValuationLocationRow[];
}> => {
  const client = unwrapDb(db);
  const entries = await client
    .select({
      locationId: inventoryEntry.locationId,
      valuation: inventoryEntry.valuation,
      placement: inventoryEntry.placement,
      productName: product.name,
    })
    .from(inventoryEntry)
    .innerJoin(product, eq(inventoryEntry.productId, product.id))
    .where(notDeleted(inventoryEntry));
  // Every live location, product-linked or not: the tree must be whole for the
  // rollup to walk it.
  const rows = await client
    .select({
      id: location.id,
      parentId: location.parentId,
      productId: location.productId,
    })
    .from(location)
    .where(notDeleted(location));
  // A second small query rather than a correlated price subquery in the select:
  // locations number in the low hundreds, and `effectiveProductPriceSql` is raw
  // SQL that has to be handed the enclosing query's exact alias — a mismatch is
  // a runtime `missing FROM-clause entry`, invisible to typecheck and to every
  // tier below integration. The loader has no alias to get wrong. (It silently
  // broke this compute; see repo/location/valuation.integration.test.ts.)
  const prices = await loadEffectiveProductPricesById(
    db,
    uniq(rows.flatMap((row) => (row.productId ? [row.productId] : []))),
  );
  const locations = rows.map((row) => ({
    id: row.id,
    parentId: row.parentId,
    productPrice: row.productId ? (prices.get(row.productId) ?? null) : null,
  }));
  return { entries, locations };
};

/**
 * Compute every live location's valuation rollup on demand — reads + pure
 * rollup, no persisted state. Cheap enough (hundreds of rows, milliseconds)
 * to call once per request path (list page, detail page, tree) rather than
 * cache; callers must call it once per request and thread the map through,
 * never per row.
 */
export const computeLocationValuations = async (
  db: Database | DrizzleTransaction,
): Promise<Map<LocationId, LocationValuation>> => {
  const { entries, locations } = await loadLocationValuationInputs(db);
  return rollupLocationValuations(entries, locations);
};
