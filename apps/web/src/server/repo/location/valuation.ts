/**
 * Location valuation — computed on read.
 *
 * There is no persisted rollup and no persisted inventory valuation:
 * `computeLocationValuations` re-derives the whole tree's valuation (a few
 * hundred locations, about a thousand entries) from live inventory + location
 * data, via the pure rollup in `services/location-valuation-rollup`, pricing
 * every entry through `inventory/valuation`. `directValuationSql` hands one
 * location's `directValuation` back to SQL as a lookup over that same
 * computed figure — usable in a WHERE/ORDER BY on the `location` table — for
 * the list filter/sort, which has no whole-tree rollup to read from.
 */

import {
  type InventoryId,
  type LocationId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type {
  LocationValuation,
  LocationValuationSummaryOut,
} from "@cubby/schemas/location";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import {
  isTransaction,
  notDeleted,
  unwrapDb,
} from "~/server/repo/database-helpers";
import {
  type InventoryValuations,
  loadInventoryValuations,
} from "~/server/repo/inventory/valuation";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";
import { rollupLocationValuations } from "~/server/services/location-valuation-rollup";

interface ValuationInventoryRow {
  id: InventoryId;
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
 * Each location's direct valuation, exactly as the pure rollup defines it: the
 * sum of positive valuations of `stock`-placement entries at the location.
 * Deliberately mirrors `loadLocationValuationInputs`'s entries join, so the
 * list-page figure and the detail-page rollup count the same population.
 */
const directValuationsByLocation = (
  entries: readonly ValuationInventoryRow[],
): Map<LocationId, number> => {
  const direct = new Map<LocationId, number>();
  for (const entry of entries) {
    if (
      entry.placement !== "stock" ||
      entry.valuation === null ||
      entry.valuation <= 0
    )
      continue;
    direct.set(
      entry.locationId,
      (direct.get(entry.locationId) ?? 0) + entry.valuation,
    );
  }
  return direct;
};

/**
 * SQL for one location's `directValuation`, for the `locationList` filter and
 * sort (a WHERE/ORDER BY on the `location` table). The whole computed map
 * travels as one jsonb parameter and each row does a key lookup — see
 * `inventoryValuationSql` for why. `location.id` is the primary table's own
 * typed column, which survives the relational-query layer's alias rewriting.
 */
export const loadDirectValuationSql = async (
  db: Database | DrizzleTransaction,
  entryValuations?: InventoryValuations,
): Promise<SQL<number>> => {
  const { entries } = await loadLocationValuationInputs(db, entryValuations);
  const direct = Object.fromEntries(directValuationsByLocation(entries));
  return sql<number>`COALESCE((${JSON.stringify(direct)}::jsonb ->> ${location.id}::text)::double precision, 0)`;
};

/** Top locations by direct value, for Home; computed, no tree or relation hydration. */
export const getLocationValuationSummary = async (
  db: Database,
): Promise<LocationValuationSummaryOut> => {
  const client = unwrapDb(db);
  // Home asks for direct stock value only, so it reads inventory once and
  // skips the whole-tree inputs (every location's own product price, a second
  // inventory join) that `loadLocationValuationInputs` exists for. Those extra
  // serial round trips were most of this read's time on every Home load.
  // An entry whose product is missing or deleted values at null either way.
  const [stock, rows] = await Promise.all([
    client
      .select({
        id: inventoryEntry.id,
        productId: inventoryEntry.productId,
        amountValue: inventoryEntry.amountValue,
        amountUnit: inventoryEntry.amountUnit,
        locationId: inventoryEntry.locationId,
      })
      .from(inventoryEntry)
      .where(
        and(notDeleted(inventoryEntry), eq(inventoryEntry.placement, "stock")),
      ),
    client
      .select({
        id: location.id,
        shortcode: location.shortcode,
        name: location.name,
      })
      .from(location)
      .where(notDeleted(location)),
  ]);
  const valuations = await loadInventoryValuations(db, stock);
  const direct = directValuationsByLocation(
    stock.map((entry) => ({
      ...entry,
      placement: "stock" as const,
      productName: "",
      valuation: valuations.get(entry.id) ?? null,
    })),
  );
  const valued = rows
    .map((row) => ({ ...row, value: direct.get(row.id) ?? 0 }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return {
    total: valued.reduce((sum, row) => sum + row.value, 0),
    locations: valued.slice(0, 5).map((row) => ({
      id: parseShortcodeFor("location", row.shortcode),
      name: row.name,
      value: row.value,
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
  entryValuations?: InventoryValuations,
): Promise<{
  entries: ValuationInventoryRow[];
  locations: ValuationLocationRow[];
}> => {
  const client = unwrapDb(db);
  // One inventory read feeds both the valuation and the rollup (it used to be
  // read twice), and the inventory and location sides are independent.
  const inventorySide = async () => {
    const entryRows = await client
      .select({
        id: inventoryEntry.id,
        productId: inventoryEntry.productId,
        amountValue: inventoryEntry.amountValue,
        amountUnit: inventoryEntry.amountUnit,
        locationId: inventoryEntry.locationId,
        placement: inventoryEntry.placement,
        productName: product.name,
      })
      .from(inventoryEntry)
      .innerJoin(product, eq(inventoryEntry.productId, product.id))
      .where(notDeleted(inventoryEntry));
    const valuations =
      entryValuations ?? (await loadInventoryValuations(db, entryRows));
    return entryRows.map(({ id, locationId, placement, productName }) => ({
      id,
      locationId,
      placement,
      productName,
      valuation: valuations.get(id) ?? null,
    }));
  };
  const locationSide = async () => {
    // Every live location, product-linked or not: the tree must be whole for
    // the rollup to walk it.
    const rows = await client
      .select({
        id: location.id,
        parentId: location.parentId,
        productId: location.productId,
      })
      .from(location)
      .where(notDeleted(location));
    // A second small query rather than a correlated price subquery in the
    // select: locations number in the low hundreds, and
    // `effectiveProductPriceSql` is raw SQL that has to be handed the enclosing
    // query's exact alias — a mismatch is a runtime `missing FROM-clause
    // entry`, invisible to typecheck and to every tier below integration. The
    // loader has no alias to get wrong. (It silently broke this compute; see
    // repo/location/valuation.integration.test.ts.)
    const prices = await loadEffectiveProductPricesById(
      db,
      uniq(rows.flatMap((row) => (row.productId ? [row.productId] : []))),
    );
    return rows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      productPrice: row.productId ? (prices.get(row.productId) ?? null) : null,
    }));
  };
  // A transaction-bound client cannot run two queries at once.
  const [entries, locations] = isTransaction(db)
    ? [await inventorySide(), await locationSide()]
    : await Promise.all([inventorySide(), locationSide()]);
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
  entryValuations?: InventoryValuations,
): Promise<Map<LocationId, LocationValuation>> => {
  const { entries, locations } = await loadLocationValuationInputs(
    db,
    entryValuations,
  );
  return rollupLocationValuations(entries, locations);
};
