import type { ProductId } from "@cubby/schemas/identifiers";
import { and, asc, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { inventoryEntry, location } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/** Live stock rows of one Product with their shelf, oldest first. */
export async function listProductStock(db: Database, productId: ProductId) {
  return await getDb(db)
    .select({
      shortcode: inventoryEntry.shortcode,
      locationShortcode: location.shortcode,
      locationName: location.name,
      value: inventoryEntry.amountValue,
      unit: inventoryEntry.amountUnit,
    })
    .from(inventoryEntry)
    .innerJoin(location, eq(location.id, inventoryEntry.locationId))
    .where(
      and(eq(inventoryEntry.productId, productId), notDeleted(inventoryEntry)),
    )
    .orderBy(asc(inventoryEntry.createdAt));
}
