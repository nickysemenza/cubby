/**
 * Inventory-centric Problems detectors.
 *
 * Only the "Unknown" bin lives here now. The never-recounted sweep moved to a
 * saved view (`inventory/never-verified`), because `verifiedPresenceFilter:
 * "none"` was already the same predicate — down to the placement default, which
 * the inventory list resolves to stock-only exactly as the detector's
 * `stockOnly()` did.
 *
 * Tenet 1: inventory never auto-decrements, so a count is only ever restored by
 * a deliberate recount. An item parked in the global "Unknown" bin is
 * unresolved bookkeeping, not accurate stock.
 */

import {
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { UnknownParkedItem } from "@cubby/schemas/problems";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import { isGlobalUnknownLocation } from "~/server/repo/location";

/**
 * Live entries parked in the global "Unknown" location — each one is a filing
 * decision a capture/import deferred. Uncapped: this bin should be drained to
 * empty, so the true count is the signal.
 *
 * includes-installed: a fixture parked in "Unknown" is still an unfiled
 * record — installation doesn't excuse it from needing a real location.
 */
export const findUnknownParkedItems = async (
  db: Database,
): Promise<UnknownParkedItem[]> => {
  const rows = await getDb(db)
    .select({
      id: inventoryEntry.id,
      shortcode: inventoryEntry.shortcode,
      amount: inventoryEntry.amount,
      createdAt: inventoryEntry.createdAt,
      productId: product.id,
      productShortcode: product.shortcode,
      productName: product.name,
      locationId: location.id,
      locationShortcode: location.shortcode,
      locationName: location.name,
    })
    .from(inventoryEntry)
    .innerJoin(
      product,
      and(eq(inventoryEntry.productId, product.id), notDeleted(product)),
    )
    .innerJoin(location, eq(inventoryEntry.locationId, location.id))
    .where(and(notDeleted(inventoryEntry), isGlobalUnknownLocation()))
    .orderBy(asc(inventoryEntry.createdAt));

  return rows.map((r) => ({
    id: unsafeInventoryShortcode(r.shortcode),
    amount: parseInventoryAmount(r.amount, r.id),
    createdAt: r.createdAt,
    product: {
      id: unsafeProductShortcode(r.productShortcode),
      name: r.productName,
    },
    location: {
      id: unsafeLocationShortcode(r.locationShortcode),
      name: r.locationName,
    },
  }));
};
