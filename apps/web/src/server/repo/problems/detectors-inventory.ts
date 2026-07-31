/**
 * Inventory-centric Problems detectors — the recount-staleness half of the
 * "is this number still true?" question (the location half lives in
 * `detectors-location.ts`).
 *
 * Tenet 1: inventory never auto-decrements, so a count is only ever restored by
 * a deliberate recount. An entry nobody has counted, and an item parked in the
 * global "Unknown" bin, are both unresolved bookkeeping — not accurate stock.
 */

import {
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type {
  NeverVerifiedInventory,
  UnknownParkedItem,
} from "@cubby/schemas/problems";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import { isGlobalUnknownLocation } from "~/server/repo/location";

/**
 * Live entries that have never been confirmed by a recount (oldest first).
 *
 * Deliberately UNCAPPED. This used to `.limit(25)` so the section wouldn't swamp
 * the navbar badge — but `verifiedAt` only started being stamped when audit
 * sessions landed, so the honest population is most of the inventory (178 of 212
 * live entries when the cap was removed). A cap that reports 25 for a real 178
 * makes the badge both wrong and unfixable, so the fix is to stop counting this
 * as a defect at all: it's classed `coverage` in `PROBLEM_CLASS`, renders as an
 * "N of M verified" meter rather than a red count, and is excluded from
 * `totalProblems`. Rendering stays bounded by `SectionGroup`'s show-all toggle.
 */
export const findNeverVerifiedInventory = async (
  db: Database,
): Promise<NeverVerifiedInventory[]> => {
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
    .innerJoin(
      location,
      and(eq(inventoryEntry.locationId, location.id), notDeleted(location)),
    )
    .where(and(notDeleted(inventoryEntry), isNull(inventoryEntry.verifiedAt)))
    .orderBy(asc(inventoryEntry.createdAt));

  return rows.map((r) => ({
    id: r.id,
    shortcode: unsafeInventoryShortcode(r.shortcode),
    amount: parseInventoryAmount(r.amount, r.id),
    createdAt: r.createdAt,
    product: {
      id: r.productId,
      shortcode: unsafeProductShortcode(r.productShortcode),
      name: r.productName,
    },
    location: {
      id: r.locationId,
      shortcode: unsafeLocationShortcode(r.locationShortcode),
      name: r.locationName,
    },
  }));
};

/**
 * Live entries parked in the global "Unknown" location — each one is a filing
 * decision a capture/import deferred. Uncapped: this bin should be drained to
 * empty, so the true count is the signal.
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
    id: r.id,
    shortcode: unsafeInventoryShortcode(r.shortcode),
    amount: parseInventoryAmount(r.amount, r.id),
    createdAt: r.createdAt,
    product: {
      id: r.productId,
      shortcode: unsafeProductShortcode(r.productShortcode),
      name: r.productName,
    },
    location: {
      id: r.locationId,
      shortcode: unsafeLocationShortcode(r.locationShortcode),
      name: r.locationName,
    },
  }));
};
