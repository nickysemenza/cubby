import { type Database, type Transaction } from "~/server/db";
import { amount } from "~/codec/codec";
import {
  withTransaction,
  insertAndReturn,
  updateAndReturn,
  relations,
  buildPartialUpdateValues,
} from "~/server/repo/database-helpers";
import { notFoundError } from "~/lib/error-messages";
import {
  InventoryBulkOperationItem,
  type BulkMovePayload,
} from "~/schemas/inventory";
import { type OrganizationId, type LocationId } from "~/schemas/identifiers";
import { inventoryEntry, location } from "~/server/db/schema";
import { eq, and } from "drizzle-orm";
import { dbInventoryEntryToAPI } from "./helpers";
import { type InventoryEntryDeepDB } from "./types";

export const bulkProcessInventoryEntries = async (
  db: Database,
  locationId: LocationId,
  items: InventoryBulkOperationItem[],
  organizationId: OrganizationId,
) => {
  // Use a transaction to ensure all operations are processed atomically
  const processedItems = await withTransaction(db, async (tx: Transaction) => {
    const results: InventoryEntryDeepDB[] = [];

    // First, get all existing inventory entries for this location
    const existingItems = await tx.query.inventoryEntry.findMany({
      where: eq(inventoryEntry.locationId, locationId),
      ...relations.inventory.full,
    });

    // Get IDs of items in the submitted array
    const submittedIds = items.filter((item) => item.id).map((item) => item.id);

    // Find items to delete (existing items not in the submitted array)
    const itemsToDelete = existingItems.filter(
      (item) => !submittedIds.includes(item.id),
    );

    // Delete items that are not in the submitted array
    for (const item of itemsToDelete) {
      await tx.delete(inventoryEntry).where(eq(inventoryEntry.id, item.id));
    }

    // Process submitted items - create new or update existing
    for (const item of items) {
      if (!item.id) {
        // Create new inventory entry - productId and amount are required
        if (!item.productId || !item.amount) {
          throw new Error("productId and amount are required for new items");
        }
        const created = await insertAndReturn(tx, inventoryEntry, {
          organizationId: organizationId,
          productId: item.productId,
          locationId: locationId,
          amount: item.amount,
        });

        // Fetch with relations
        const fullCreated = await tx.query.inventoryEntry.findFirst({
          where: eq(inventoryEntry.id, created.id),
          ...relations.inventory.full,
        });

        if (fullCreated) {
          results.push(fullCreated);
        }
      } else {
        // Update existing inventory entry using helper to filter undefined
        const updateValues = buildPartialUpdateValues({
          amount: item.amount,
          productId: item.productId,
        });

        // Only process if there are actual updates
        if (Object.keys(updateValues).length > 0) {
          const updated = await updateAndReturn(
            tx,
            inventoryEntry,
            updateValues,
            eq(inventoryEntry.id, item.id),
          );

          // Fetch with relations
          const fullUpdated = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, updated.id),
            ...relations.inventory.full,
          });

          if (fullUpdated) {
            results.push(fullUpdated);
          }
        } else {
          // If no updates, just fetch the current item
          const current = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, item.id),
            ...relations.inventory.full,
          });

          if (current) {
            results.push(current);
          }
        }
      }
    }

    // Update the location's lastBulkInventory timestamp
    await tx
      .update(location)
      .set({ lastBulkInventory: new Date() })
      .where(eq(location.id, locationId));

    return results;
  });

  return processedItems.map(dbInventoryEntryToAPI);
};

/**
 * Bulk move inventory entries from one location to another.
 * Supports partial moves (moving less than the full quantity).
 */
export const bulkMoveInventoryEntries = async (
  db: Database,
  organizationId: OrganizationId,
  payload: BulkMovePayload,
) => {
  // Validate source and target are different
  if (payload.sourceLocationId === payload.targetLocationId) {
    throw new Error("Source and target locations must be different");
  }

  const processedItems = await withTransaction(db, async (tx: Transaction) => {
    const results: InventoryEntryDeepDB[] = [];

    for (const item of payload.items) {
      // 1. Get source entry
      const sourceEntry = await tx.query.inventoryEntry.findFirst({
        where: and(
          eq(inventoryEntry.id, item.inventoryEntryId),
          eq(inventoryEntry.organizationId, organizationId),
        ),
        ...relations.inventory.full,
      });

      if (!sourceEntry) {
        throw new Error(
          notFoundError("Inventory entry", item.inventoryEntryId),
        );
      }

      // 2. Parse quantities (amount.value is already a number)
      const parsedSourceAmount = amount.parse(sourceEntry.amount);
      const sourceQuantity = parsedSourceAmount.value;
      const moveQuantity = item.quantity.value;

      if (moveQuantity > sourceQuantity) {
        throw new Error(
          `Cannot move ${moveQuantity} ${item.quantity.unit} - only ${sourceQuantity} available`,
        );
      }

      // 3. Check if product already exists at target location
      const existingAtTarget = await tx.query.inventoryEntry.findFirst({
        where: and(
          eq(inventoryEntry.productId, sourceEntry.productId),
          eq(inventoryEntry.locationId, payload.targetLocationId),
          eq(inventoryEntry.organizationId, organizationId),
        ),
        ...relations.inventory.full,
      });

      if (moveQuantity >= sourceQuantity) {
        // Full move
        if (existingAtTarget) {
          // Merge with existing entry at target
          const existingAmount = amount.parse(existingAtTarget.amount);
          const existingQuantity = existingAmount.value;
          const newQuantity = existingQuantity + moveQuantity;

          // Update target entry with combined quantity
          await updateAndReturn(
            tx,
            inventoryEntry,
            { amount: { value: newQuantity, unit: item.quantity.unit } },
            eq(inventoryEntry.id, existingAtTarget.id),
          );

          // Delete source entry since we moved everything
          await tx
            .delete(inventoryEntry)
            .where(eq(inventoryEntry.id, item.inventoryEntryId));

          // Fetch updated target entry
          const updatedTarget = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, existingAtTarget.id),
            ...relations.inventory.full,
          });
          if (updatedTarget) results.push(updatedTarget);
        } else {
          // Just update location of existing entry
          await updateAndReturn(
            tx,
            inventoryEntry,
            { locationId: payload.targetLocationId },
            eq(inventoryEntry.id, item.inventoryEntryId),
          );

          // Fetch updated entry
          const updated = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, item.inventoryEntryId),
            ...relations.inventory.full,
          });
          if (updated) results.push(updated);
        }
      } else {
        // Partial move - reduce source and create/update target
        const remainingQuantity = sourceQuantity - moveQuantity;

        // Reduce source quantity
        await updateAndReturn(
          tx,
          inventoryEntry,
          {
            amount: {
              value: remainingQuantity,
              unit: parsedSourceAmount.unit,
            },
          },
          eq(inventoryEntry.id, item.inventoryEntryId),
        );

        if (existingAtTarget) {
          // Add to existing entry at target
          const existingAmount = amount.parse(existingAtTarget.amount);
          const existingQuantity = existingAmount.value;
          const newQuantity = existingQuantity + moveQuantity;

          await updateAndReturn(
            tx,
            inventoryEntry,
            { amount: { value: newQuantity, unit: item.quantity.unit } },
            eq(inventoryEntry.id, existingAtTarget.id),
          );

          // Fetch updated target entry
          const updatedTarget = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, existingAtTarget.id),
            ...relations.inventory.full,
          });
          if (updatedTarget) results.push(updatedTarget);
        } else {
          // Create new entry at target
          const created = await insertAndReturn(tx, inventoryEntry, {
            organizationId: organizationId,
            productId: sourceEntry.productId,
            locationId: payload.targetLocationId,
            amount: item.quantity,
          });

          // Fetch with relations
          const fullCreated = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, created.id),
            ...relations.inventory.full,
          });
          if (fullCreated) results.push(fullCreated);
        }
      }
    }

    return results;
  });

  return processedItems.map(dbInventoryEntryToAPI);
};
