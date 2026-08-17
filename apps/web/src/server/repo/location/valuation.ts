/**
 * Location valuation repository — DB reads/writes for the persisted per-location
 * inventory-valuation rollup. The pure rollup math lives in
 * location-valuation.service; this file owns the schema access (per the layering
 * lint: services go through repo functions).
 */

import type { LocationId } from "@cubby/schemas/identifiers";
import type { LocationValuation } from "@cubby/schemas/location";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import {
  batchUpdateWithCaseWhen,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { effectiveProductPriceSql } from "~/server/repo/product/pricing";

interface ValuationInventoryRow {
  locationId: LocationId;
  valuation: number | null;
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
  // Left join: most locations are not an instance of a product, and those
  // that are must still appear in the tree so the rollup can walk them.
  const locations = await client
    .select({
      id: location.id,
      parentId: location.parentId,
      productPrice: sql<
        number | null
      >`CASE WHEN ${product.id} IS NULL THEN NULL ELSE ${sql.raw(effectiveProductPriceSql())} END`.as(
        "productPrice",
      ),
    })
    .from(location)
    .leftJoin(
      product,
      and(eq(location.productId, product.id), notDeleted(product)),
    )
    .where(notDeleted(location));
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
