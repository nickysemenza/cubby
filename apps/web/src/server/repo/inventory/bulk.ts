import { and, eq } from "drizzle-orm";
import type { ActorContext } from "~/schemas/context";
import type { LocationId } from "~/schemas/identifiers";
import { unsafeProductId } from "~/schemas/identifiers";
import type {
  BulkMovePayload,
  InventoryBulkOperationItem,
} from "~/schemas/inventory";
import { createAppError } from "~/server/api/trpc";
import type { Database, DrizzleTransaction } from "~/server/db";
import { inventoryEntry, location } from "~/server/db/schema";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  buildPartialUpdateValues,
  insertAndReturn,
  parseInventoryAmount,
  relations,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { computeValuationForEntry } from "./crud";
import { dbInventoryEntryToAPI } from "./helpers";
import type { InventoryEntryDeepDB } from "./types";

export const bulkProcessInventoryEntries = async (
  db: Database,
  locationId: LocationId,
  items: InventoryBulkOperationItem[],
  actor: ActorContext,
) => {
  // Use a transaction to ensure all operations are processed atomically
  const processedItems = await withTransaction(
    db,
    async (tx: DrizzleTransaction) => {
      const results: InventoryEntryDeepDB[] = [];

      // First, get all existing inventory entries for this location
      const existingItems = await tx.query.inventoryEntry.findMany({
        where: eq(inventoryEntry.locationId, locationId),
        ...relations.inventory.full,
      });

      // Create a map of existing items for change tracking
      const existingItemsMap = new Map(
        existingItems.map((item) => [item.id, item]),
      );

      // Get IDs of items in the submitted array (as plain strings for DB comparison)
      const submittedIds = items
        .filter((item) => item.id)
        .map((item) => item.id as string);

      // Find items to delete (existing items not in the submitted array)
      const itemsToDelete = existingItems.filter(
        (item) => !submittedIds.includes(item.id),
      );

      // Delete items that are not in the submitted array
      for (const item of itemsToDelete) {
        await tx.delete(inventoryEntry).where(eq(inventoryEntry.id, item.id));
        // Log delete audit entry
        await logAuditEntry(tx, actor, {
          entityType: "inventory",
          entityId: item.id,
          action: "delete",
        });
      }

      // Process submitted items - create new or update existing
      for (const item of items) {
        if (!item.id) {
          // Create new inventory entry - productId and amount are required
          if (!item.productId || !item.amount) {
            throw new Error("productId and amount are required for new items");
          }

          // Compute valuation based on amount and product price
          const amountValue =
            typeof item.amount === "object" && item.amount !== null
              ? (item.amount as { value: number }).value
              : 0;
          const valuation = await computeValuationForEntry(
            tx,
            item.productId,
            amountValue,
          );

          const created = await insertAndReturn(tx, inventoryEntry, {
            productId: item.productId,
            locationId: locationId,
            amount: item.amount,
            valuation,
          });

          // Log create audit entry
          await logAuditEntry(tx, actor, {
            entityType: "inventory",
            entityId: created.id,
            action: "create",
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

          // Recompute valuation if amount or productId changed
          let valuation: number | null | undefined;
          if (item.amount !== undefined || item.productId !== undefined) {
            const before = existingItemsMap.get(item.id);
            // Use new values if provided, otherwise use existing values
            const effectiveProductId = item.productId ?? before?.productId;
            const effectiveAmount = item.amount ?? before?.amount;
            const amountValue =
              typeof effectiveAmount === "object" && effectiveAmount !== null
                ? (effectiveAmount as { value: number }).value
                : 0;

            if (effectiveProductId) {
              valuation = await computeValuationForEntry(
                tx,
                effectiveProductId,
                amountValue,
              );
            }
          }

          // Add valuation to update values
          const finalUpdateValues = buildPartialUpdateValues({
            ...updateValues,
            valuation,
          });

          // Only process if there are actual updates
          if (Object.keys(finalUpdateValues).length > 0) {
            const before = existingItemsMap.get(item.id);
            const updated = await updateAndReturn(
              tx,
              inventoryEntry,
              finalUpdateValues,
              eq(inventoryEntry.id, item.id),
            );

            // Log update audit entry with changes
            if (before) {
              const changes = computeChanges(before, updated, [
                "amount",
                "productId",
              ]);
              if (changes) {
                await logAuditEntry(tx, actor, {
                  entityType: "inventory",
                  entityId: item.id,
                  action: "update",
                  changes,
                });
              }
            }

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
    },
  );

  return processedItems.map(dbInventoryEntryToAPI);
};

/**
 * Bulk move inventory entries from one location to another.
 * Supports partial moves (moving less than the full quantity).
 */
export const bulkMoveInventoryEntries = async (
  db: Database,
  payload: BulkMovePayload,
  actor: ActorContext,
) => {
  // Validate source and target are different
  if (payload.sourceLocationId === payload.targetLocationId) {
    throw new Error("Source and target locations must be different");
  }

  const processedItems = await withTransaction(
    db,
    async (tx: DrizzleTransaction) => {
      const results: InventoryEntryDeepDB[] = [];

      for (const item of payload.items) {
        // 1. Get source entry
        const sourceEntry = await tx.query.inventoryEntry.findFirst({
          where: eq(inventoryEntry.id, item.inventoryEntryId),
          ...relations.inventory.full,
        });

        if (!sourceEntry) {
          throw createAppError(
            "INVENTORY_NOT_FOUND",
            `Inventory entry ${item.inventoryEntryId} not found`,
          );
        }

        // 2. Parse quantities (amount.value is already a number)
        const parsedSourceAmount = parseInventoryAmount(
          sourceEntry.amount,
          sourceEntry.id,
        );
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
          ),
          ...relations.inventory.full,
        });

        if (moveQuantity >= sourceQuantity) {
          // Full move
          if (existingAtTarget) {
            // Merge with existing entry at target
            const existingAmount = parseInventoryAmount(
              existingAtTarget.amount,
              existingAtTarget.id,
            );
            const existingQuantity = existingAmount.value;
            const newQuantity = existingQuantity + moveQuantity;

            // Recompute valuation for updated quantity
            const valuation = await computeValuationForEntry(
              tx,
              unsafeProductId(sourceEntry.productId),
              newQuantity,
            );

            // Update target entry with combined quantity
            const updatedTargetEntry = await updateAndReturn(
              tx,
              inventoryEntry,
              {
                amount: { value: newQuantity, unit: item.quantity.unit },
                valuation,
              },
              eq(inventoryEntry.id, existingAtTarget.id),
            );

            // Log update audit for target
            const targetChanges = computeChanges(
              existingAtTarget,
              updatedTargetEntry,
              ["amount"],
            );
            if (targetChanges) {
              await logAuditEntry(tx, actor, {
                entityType: "inventory",
                entityId: existingAtTarget.id,
                action: "update",
                changes: targetChanges,
              });
            }

            // Delete source entry since we moved everything
            await tx
              .delete(inventoryEntry)
              .where(eq(inventoryEntry.id, item.inventoryEntryId));

            // Log delete audit for source
            await logAuditEntry(tx, actor, {
              entityType: "inventory",
              entityId: item.inventoryEntryId,
              action: "delete",
            });

            // Fetch updated target entry
            const updatedTarget = await tx.query.inventoryEntry.findFirst({
              where: eq(inventoryEntry.id, existingAtTarget.id),
              ...relations.inventory.full,
            });
            if (updatedTarget) results.push(updatedTarget);
          } else {
            // Just update location of existing entry
            const updatedEntry = await updateAndReturn(
              tx,
              inventoryEntry,
              { locationId: payload.targetLocationId },
              eq(inventoryEntry.id, item.inventoryEntryId),
            );

            // Log update audit for location change
            const locationChanges = computeChanges(sourceEntry, updatedEntry, [
              "locationId",
            ]);
            if (locationChanges) {
              await logAuditEntry(tx, actor, {
                entityType: "inventory",
                entityId: item.inventoryEntryId,
                action: "update",
                changes: locationChanges,
              });
            }

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

          // Recompute valuation for reduced quantity
          const sourceValuation = await computeValuationForEntry(
            tx,
            unsafeProductId(sourceEntry.productId),
            remainingQuantity,
          );

          // Reduce source quantity
          const updatedSource = await updateAndReturn(
            tx,
            inventoryEntry,
            {
              amount: {
                value: remainingQuantity,
                unit: parsedSourceAmount.unit,
              },
              valuation: sourceValuation,
            },
            eq(inventoryEntry.id, item.inventoryEntryId),
          );

          // Log update audit for source reduction
          const sourceChanges = computeChanges(sourceEntry, updatedSource, [
            "amount",
          ]);
          if (sourceChanges) {
            await logAuditEntry(tx, actor, {
              entityType: "inventory",
              entityId: item.inventoryEntryId,
              action: "update",
              changes: sourceChanges,
            });
          }

          if (existingAtTarget) {
            // Add to existing entry at target
            const existingAmount = parseInventoryAmount(
              existingAtTarget.amount,
              existingAtTarget.id,
            );
            const existingQuantity = existingAmount.value;
            const newQuantity = existingQuantity + moveQuantity;

            // Recompute valuation for updated quantity
            const targetValuation = await computeValuationForEntry(
              tx,
              unsafeProductId(sourceEntry.productId),
              newQuantity,
            );

            const updatedTargetEntry = await updateAndReturn(
              tx,
              inventoryEntry,
              {
                amount: { value: newQuantity, unit: item.quantity.unit },
                valuation: targetValuation,
              },
              eq(inventoryEntry.id, existingAtTarget.id),
            );

            // Log update audit for target
            const targetChanges2 = computeChanges(
              existingAtTarget,
              updatedTargetEntry,
              ["amount"],
            );
            if (targetChanges2) {
              await logAuditEntry(tx, actor, {
                entityType: "inventory",
                entityId: existingAtTarget.id,
                action: "update",
                changes: targetChanges2,
              });
            }

            // Fetch updated target entry
            const updatedTarget = await tx.query.inventoryEntry.findFirst({
              where: eq(inventoryEntry.id, existingAtTarget.id),
              ...relations.inventory.full,
            });
            if (updatedTarget) results.push(updatedTarget);
          } else {
            // Create new entry at target
            // Compute valuation based on amount and product price
            const amountValue = item.quantity.value;
            const valuation = await computeValuationForEntry(
              tx,
              unsafeProductId(sourceEntry.productId),
              amountValue,
            );

            const created = await insertAndReturn(tx, inventoryEntry, {
              productId: sourceEntry.productId,
              locationId: payload.targetLocationId,
              amount: item.quantity,
              valuation,
            });

            // Log create audit for new target entry
            await logAuditEntry(tx, actor, {
              entityType: "inventory",
              entityId: created.id,
              action: "create",
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

      // Update lastBulkInventory for both source and target locations
      const now = new Date();
      await tx
        .update(location)
        .set({ lastBulkInventory: now })
        .where(eq(location.id, payload.sourceLocationId));
      await tx
        .update(location)
        .set({ lastBulkInventory: now })
        .where(eq(location.id, payload.targetLocationId));

      return results;
    },
  );

  return processedItems.map(dbInventoryEntryToAPI);
};
