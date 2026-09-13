import type { LocationId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { InventoryItemForTree } from "@cubby/schemas/location";
import { and, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { inventoryEntry, product } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { stockOnly } from "~/server/repo/inventory/placement";

/**
 * The one loader behind a location payload's `inventoryItems` AND its
 * `directItemCount`: the count is the list's length, so the two cannot
 * disagree. Every tree/detail surface that reports both must read them here.
 *
 * Stock only (`stockOnly()`), per the rule in `inventory/placement.ts`:
 * installed fixtures are not items you can walk over and count, and the
 * computed `location.valuation` rollup excludes them too.
 *
 * Regression: `getLocationById` once counted via its own GROUP BY and left
 * `inventoryItems` unmapped, so the HTTP/CLI resource detail reported
 * `directItemCount: 12` next to `inventoryItems: []`.
 */
export const loadStockItemsByLocation = async (
  db: Database | DrizzleTransaction,
  locationIds: readonly LocationId[],
): Promise<ReadonlyMap<LocationId, InventoryItemForTree[]>> => {
  const itemsByLocationId = new Map<LocationId, InventoryItemForTree[]>();
  if (locationIds.length === 0) return itemsByLocationId;

  const rows = await unwrapDb(db)
    .select({
      locationId: inventoryEntry.locationId,
      shortcode: inventoryEntry.shortcode,
      amount: inventoryEntry.amount,
      productShortcode: product.shortcode,
      productName: product.name,
    })
    .from(inventoryEntry)
    .innerJoin(product, eq(inventoryEntry.productId, product.id))
    .where(
      and(
        inArray(inventoryEntry.locationId, [...locationIds]),
        notDeleted(inventoryEntry),
        stockOnly(),
      ),
    )
    .orderBy(product.name);

  for (const row of rows) {
    const items = itemsByLocationId.get(row.locationId) ?? [];
    items.push({
      id: parseShortcodeFor("inventory", row.shortcode),
      amount: row.amount,
      productName: row.productName,
      productId: parseShortcodeFor("product", row.productShortcode),
    });
    itemsByLocationId.set(row.locationId, items);
  }
  return itemsByLocationId;
};
