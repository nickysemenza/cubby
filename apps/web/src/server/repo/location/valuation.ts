/**
 * Location valuation repository — DB reads/writes for the persisted per-location
 * inventory-valuation rollup. The pure rollup math lives in
 * location-valuation.service; this file owns the schema access (per the layering
 * lint: services go through repo functions).
 */

import type { LocationId } from "@cubby/schemas/identifiers";
import type { LocationValuation } from "@cubby/schemas/location";
import { eq } from "drizzle-orm";
import type { Database } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import {
  batchUpdateWithCaseWhen,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";

interface ValuationInventoryRow {
  locationId: LocationId;
  valuation: number | null;
  productName: string;
}

interface ValuationLocationRow {
  id: LocationId;
  parentId: LocationId | null;
}

/**
 * Read the inputs for a whole-tree valuation recompute: every non-deleted
 * inventory item (location, valuation, product name) and every non-deleted
 * location (id, parentId).
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
      productName: product.name,
    })
    .from(inventoryEntry)
    .innerJoin(product, eq(inventoryEntry.productId, product.id))
    .where(notDeleted(inventoryEntry));
  const locations = await client
    .select({ id: location.id, parentId: location.parentId })
    .from(location)
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
