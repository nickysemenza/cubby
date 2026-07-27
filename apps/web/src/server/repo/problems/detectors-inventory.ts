/**
 * Inventory-centric Problems detectors — the recount-staleness half of the
 * "is this number still true?" question (the location half lives in
 * `detectors-location.ts`).
 *
 * Tenet 1: inventory never auto-decrements, so a count is only ever restored by
 * a deliberate recount. An entry nobody has counted, and an item parked in the
 * global "Unknown" bin, are both unresolved bookkeeping — not accurate stock.
 */

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
 * Display cap for the never-verified list. `verifiedAt` only started being
 * stamped when audit sessions landed, so the honest population is "most of the
 * inventory" — an uncapped section would be a wall of rows and would swamp the
 * navbar badge. The oldest entries lead (they've gone longest unconfirmed), and
 * the count shown always equals the rows listed, like every other detector.
 */
const NEVER_VERIFIED_SAMPLE_LIMIT = 25;

/** Live entries that have never been confirmed by a recount (oldest first). */
export const findNeverVerifiedInventory = async (
  db: Database,
): Promise<NeverVerifiedInventory[]> => {
  const rows = await getDb(db)
    .select({
      id: inventoryEntry.id,
      amount: inventoryEntry.amount,
      createdAt: inventoryEntry.createdAt,
      productId: product.id,
      productName: product.name,
      locationId: location.id,
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
    .orderBy(asc(inventoryEntry.createdAt))
    .limit(NEVER_VERIFIED_SAMPLE_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    amount: parseInventoryAmount(r.amount, r.id),
    createdAt: r.createdAt,
    product: { id: r.productId, name: r.productName },
    location: { id: r.locationId, name: r.locationName },
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
      amount: inventoryEntry.amount,
      createdAt: inventoryEntry.createdAt,
      productId: product.id,
      productName: product.name,
      locationId: location.id,
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
    amount: parseInventoryAmount(r.amount, r.id),
    createdAt: r.createdAt,
    product: { id: r.productId, name: r.productName },
    location: { id: r.locationId, name: r.locationName },
  }));
};
