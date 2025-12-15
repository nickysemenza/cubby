/**
 * Inventory handling functions for CSV import
 *
 * Handles inventory creation, updates, moves, and checking.
 */

import { type Database } from "~/server/db";
import {
  type OrganizationId,
  type ProductId,
  type LocationId,
} from "~/schemas/identifiers";
import { getDb } from "~/server/repo/database-helpers";
import { inventoryEntry } from "~/server/db/schema";
import { eq, and } from "drizzle-orm";
import { amount } from "~/codec/codec";
import { type InventoryMatchResult } from "./types";

/**
 * Move all inventory entries of a product to a new target location
 *
 * Deletes existing entries and creates a new one at the target.
 * Returns the names of locations the product was moved from.
 */
export const moveInventoryEntries = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
  targetLocationId: LocationId,
  newAmount: { value: number; unit: string },
): Promise<string[]> => {
  const existingEntries = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
    with: {
      location: true,
    },
  });

  if (existingEntries.length === 0) {
    return [];
  }

  // Delete existing entries
  for (const entry of existingEntries) {
    await getDb(db)
      .delete(inventoryEntry)
      .where(eq(inventoryEntry.id, entry.id));
  }

  // Check if already exists at target location
  const existingAtTarget = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.locationId, targetLocationId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  });

  if (!existingAtTarget) {
    await getDb(db).insert(inventoryEntry).values({
      organizationId,
      productId,
      locationId: targetLocationId,
      amount: newAmount,
    });
  }

  return existingEntries.map((e) => e.location.name);
};

/**
 * Create or update inventory at a target location
 *
 * If inventory exists at target, adds to the quantity.
 * Returns "created" or "updated" indicating what action was taken.
 */
export const createOrUpdateInventoryAtLocation = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
  targetLocationId: LocationId,
  newAmount: { value: number; unit: string },
): Promise<"created" | "updated"> => {
  const existingAtTarget = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.locationId, targetLocationId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  });

  if (existingAtTarget) {
    const existingAmount = amount.parse(existingAtTarget.amount);
    await getDb(db)
      .update(inventoryEntry)
      .set({
        amount: {
          value: existingAmount.value + newAmount.value,
          unit: newAmount.unit,
        },
      })
      .where(eq(inventoryEntry.id, existingAtTarget.id));
    return "updated";
  }

  await getDb(db).insert(inventoryEntry).values({
    organizationId,
    productId,
    locationId: targetLocationId,
    amount: newAmount,
  });
  return "created";
};

/**
 * Get location names where a product currently has inventory
 */
export const getExistingInventoryLocations = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
): Promise<string[]> => {
  const existingEntries = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
    with: {
      location: true,
    },
  });

  return existingEntries.map((e) => e.location.name);
};

/**
 * Check if inventory exists at target location and if quantity matches
 */
export const checkInventoryMatch = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
  targetLocationId: LocationId,
  expectedAmount: { value: number; unit: string },
): Promise<InventoryMatchResult> => {
  const existing = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.locationId, targetLocationId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  });
  if (!existing) return { exists: false, matches: false };
  const existingAmount = amount.parse(existing.amount);
  const matches =
    existingAmount.value === expectedAmount.value &&
    existingAmount.unit === expectedAmount.unit;
  return { exists: true, matches };
};
