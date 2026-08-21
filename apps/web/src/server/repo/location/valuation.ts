/**
 * Location valuation repository — DB reads/writes for the persisted per-location
 * inventory-valuation rollup. The pure rollup math lives in
 * location-valuation.service; this file owns the schema access (per the layering
 * lint: services go through repo functions).
 */

import {
  type LocationId,
  unsafeLocationShortcode,
} from "@cubby/schemas/identifiers";
import type {
  LocationValuation,
  LocationValuationSummaryOut,
} from "@cubby/schemas/location";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import {
  batchUpdateWithCaseWhen,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";

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

/** One compact SQL read for Home; no tree or relation hydration. */
export const getLocationValuationSummary = async (
  db: Database,
): Promise<LocationValuationSummaryOut> => {
  const directValue = sql<number>`COALESCE((${location.valuation}->>'directValuation')::numeric, 0)`;
  const rows = await getDb(db)
    .select({
      id: location.shortcode,
      name: location.name,
      value: directValue,
      total: sql<number>`SUM(${directValue}) OVER ()`,
    })
    .from(location)
    .where(and(notDeleted(location), gt(directValue, 0)))
    .orderBy(desc(directValue), location.name)
    .limit(5);

  return {
    total: Number(rows[0]?.total ?? 0),
    locations: rows.map((row) => ({
      id: unsafeLocationShortcode(row.id),
      name: row.name,
      value: Number(row.value),
    })),
  };
};

/**
 * Read the inputs for a whole-tree valuation recompute: every non-deleted
 * inventory item (location, valuation, product name) and every non-deleted
 * location (id, parentId, and the price of the SKU it is).
 */
export const getLocationValuationInputs = async (
  db: Database,
): Promise<{
  entries: ValuationInventoryRow[];
  locations: ValuationLocationRow[];
}> => {
  const client = getDb(db);
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
  // broke this recompute; see services/location-valuation.integration.test.ts.)
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
 * Persist the recomputed rollups in a single batched UPDATE (CASE WHEN) per
 * chunk instead of one round-trip per location — a whole-tree recompute can
 * touch every location, and each serial `await` was its own Hyperdrive round
 * trip. Wrapped in a transaction so a multi-chunk write stays atomic.
 */
export const writeLocationValuations = async (
  db: Database,
  updates: { id: LocationId; valuation: LocationValuation | null }[],
): Promise<void> => {
  if (updates.length === 0) return;
  await withTransaction(db, async (tx) => {
    await batchUpdateWithCaseWhen(tx, location, updates);
  });
};
