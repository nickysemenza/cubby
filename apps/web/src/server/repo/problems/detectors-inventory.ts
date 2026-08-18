/**
 * Inventory-centric Problems detectors.
 *
 * The "Unknown" bin and the unpriceable-unit sweep. The never-recounted sweep
 * moved to a saved view (`inventory/never-verified`), because
 * `verifiedPresenceFilter: "none"` was already the same predicate — down to the
 * placement default, which the inventory list resolves to stock-only exactly as
 * the detector's `stockOnly()` did.
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
import type {
  InventoryWithoutPricePath,
  UnknownParkedItem,
} from "@cubby/schemas/problems";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import { isGlobalUnknownLocation } from "~/server/repo/location";
import { effectiveProductPriceSql } from "~/server/repo/product/pricing";

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

/**
 * Live entries with **no valuation despite a priced Product** — the amount's
 * unit has no path to money through that Product's unit-mapping graph.
 *
 * `valuation` is null for two reasons that need opposite fixes: nobody set a
 * price (fix: set one), or a price exists and this unit can't reach it (fix:
 * add the conversion edge, e.g. `1 each = 4 roll`). The location rollup's
 * `missingPricing` bucket lumps both together, so the second one is invisible
 * there. This detector isolates it by pinning the half that is decidable in
 * SQL: valuation null AND effective price not null.
 *
 * Expected to report ZERO today — every live entry is in `each` or in a unit
 * that already carries a mapping. It lands as a regression signal, the same
 * shape `findReferentialLivenessViolations` uses: a row here means a write path
 * stored a unit the product's graph cannot price.
 *
 * includes-installed: a fixture's valuation feeds the same rollups a stock
 * row's does, so an unpriceable unit is just as wrong on one.
 */
export const findInventoryWithoutPricePath = async (
  db: Database,
): Promise<InventoryWithoutPricePath[]> => {
  const rows = await getDb(db)
    .select({
      id: inventoryEntry.id,
      shortcode: inventoryEntry.shortcode,
      amount: inventoryEntry.amount,
      productShortcode: product.shortcode,
      productName: product.name,
      locationShortcode: location.shortcode,
      locationName: location.name,
      // The SQL twin of `explicit ?? derived` — kept identical to
      // `loadProductPricing`, which is what actually computed the null.
      effectivePrice: sql<number>`${sql.raw(effectiveProductPriceSql('"Product"'))}`,
    })
    .from(inventoryEntry)
    .innerJoin(
      product,
      and(eq(inventoryEntry.productId, product.id), notDeleted(product)),
    )
    .innerJoin(
      location,
      and(eq(inventoryEntry.locationId, location.id), notDeleted(location)),
    )
    .where(
      and(
        notDeleted(inventoryEntry),
        isNull(inventoryEntry.valuation),
        sql`${sql.raw(effectiveProductPriceSql('"Product"'))} IS NOT NULL`,
      ),
    )
    .orderBy(asc(inventoryEntry.createdAt));

  return rows.map((r) => ({
    id: unsafeInventoryShortcode(r.shortcode),
    amount: parseInventoryAmount(r.amount, r.id),
    effectivePrice: Number(r.effectivePrice),
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
