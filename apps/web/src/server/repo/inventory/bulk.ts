import type { ActorContext } from "@cubby/schemas/context";
import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import { unsafeInventoryId } from "@cubby/schemas/identifiers";
import type {
  BulkMovePayload,
  InventoryBulkOperationItem,
} from "@cubby/schemas/inventory";
import { and, eq, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { computeInventoryValuation } from "~/lib/price-mapping-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  type AuditEntryInput,
  computeChanges,
  logAuditEntries,
} from "~/server/repo/audit-log";
import {
  buildPartialUpdateValues,
  insertAndReturn,
  notDeleted,
  parseInventoryAmount,
  relations,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { assertLiveTargets } from "./helpers";
import { dbInventoryEntryToAPI } from "./mappers";
import type { InventoryEntryDeepDB } from "./types";

/** Batch fetch inventory entries with full relations, preserving order. */
async function batchFetchResults(
  tx: DrizzleTransaction,
  resultIds: string[],
): Promise<InventoryEntryDeepDB[]> {
  if (resultIds.length === 0) return [];
  const fetched = await tx.query.inventoryEntry.findMany({
    where: inArray(
      inventoryEntry.id,
      resultIds.map((id) => unsafeInventoryId(id)),
    ),
    ...relations.inventory.full,
  });
  const fetchedById = new Map<string, InventoryEntryDeepDB>(
    fetched.map((r) => [r.id, r]),
  );
  return resultIds
    .map((id) => fetchedById.get(id))
    .filter((r) => r != null) as InventoryEntryDeepDB[];
}

export const bulkProcessInventoryEntries = async (
  db: Database,
  locationId: LocationId,
  items: InventoryBulkOperationItem[],
  actor: ActorContext,
) => {
  // Transaction boundary: the entire diff (deletes of removed items, creates +
  // updates of submitted items, audit logging, and the location timestamp bump)
  // commits or rolls back as one unit so a partial failure leaves no half-applied
  // bulk state.
  const processedItems = await withTransaction(
    db,
    async (tx: DrizzleTransaction) => {
      // Guard: never create/re-point entries at a soft-deleted target. Validate
      // the shelf location once, then batch-validate every submitted product id
      // (the UI filters deleted options, but the tRPC API is callable directly).
      await assertLiveTargets(tx, { locationId });
      const submittedProductIds = uniq(
        items.filter((i) => i.productId).map((i) => i.productId as ProductId),
      );
      if (submittedProductIds.length > 0) {
        const liveProducts = await tx
          .select({ id: product.id })
          .from(product)
          .where(
            and(inArray(product.id, submittedProductIds), notDeleted(product)),
          );
        const liveIds = new Set(liveProducts.map((p) => p.id));
        const missing = submittedProductIds.find((id) => !liveIds.has(id));
        if (missing) {
          throw createAppError(
            "PRODUCT_NOT_FOUND",
            `Product ${missing} does not exist or has been deleted`,
          );
        }
      }

      // First, get all existing inventory entries for this location
      const existingItems = await tx.query.inventoryEntry.findMany({
        where: and(
          eq(inventoryEntry.locationId, locationId),
          notDeleted(inventoryEntry),
        ),
        ...relations.inventory.full,
      });

      // Create a map of existing items for change tracking
      const existingItemsMap = new Map(
        existingItems.map((item) => [item.id, item]),
      );

      // Pre-fetch all product prices in a single query
      const allProductIds = uniq([
        ...items
          .filter((i) => i.productId)
          .map((i) => i.productId as ProductId),
        ...existingItems.map((i) => i.productId),
      ]);
      const priceMap = new Map<string, number | null>();
      if (allProductIds.length > 0) {
        const products = await tx
          .select({ id: product.id, price: product.price })
          .from(product)
          .where(inArray(product.id, allProductIds));
        for (const p of products) {
          priceMap.set(p.id, p.price);
        }
      }

      // Get IDs of items in the submitted array (as plain strings for DB comparison)
      const submittedIds = items
        .filter((item) => item.id)
        .map((item) => item.id as string);

      // Find items to delete (existing items not in the submitted array)
      const itemsToDelete = existingItems.filter(
        (item) => !submittedIds.includes(item.id),
      );

      // Batch delete items that are not in the submitted array
      if (itemsToDelete.length > 0) {
        const idsToDelete = itemsToDelete.map((item) => item.id);
        await tx
          .delete(inventoryEntry)
          .where(inArray(inventoryEntry.id, idsToDelete));

        // Batch log delete audit entries
        await logAuditEntries(
          tx,
          actor,
          itemsToDelete.map((item) => ({
            entityType: "inventory" as const,
            entityId: item.id,
            action: "delete" as const,
          })),
        );
      }

      // Collect result IDs and audit entries during processing
      const resultIds: string[] = [];
      const auditEntries: AuditEntryInput[] = [];

      // Process submitted items - create new or update existing
      for (const item of items) {
        if (!item.id) {
          // Create new inventory entry - productId and amount are required
          if (!item.productId || !item.amount) {
            throw createAppError(
              "REQUIRED_FIELD_MISSING",
              "productId and amount are required for new items",
            );
          }

          // Compute valuation using pre-fetched price
          const amountValue =
            typeof item.amount === "object" && item.amount !== null
              ? (item.amount as { value: number }).value
              : 0;
          const valuation = computeInventoryValuation(
            amountValue,
            priceMap.get(item.productId) ?? null,
          );

          const created = await insertAndReturn(tx, inventoryEntry, {
            productId: item.productId,
            locationId: locationId,
            amount: item.amount,
            valuation,
          });

          resultIds.push(created.id);
          auditEntries.push({
            entityType: "inventory",
            entityId: created.id,
            action: "create",
          });
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
            const effectiveProductId = item.productId ?? before?.productId;
            const effectiveAmount = item.amount ?? before?.amount;
            const amountValue =
              typeof effectiveAmount === "object" && effectiveAmount !== null
                ? (effectiveAmount as { value: number }).value
                : 0;

            if (effectiveProductId) {
              valuation = computeInventoryValuation(
                amountValue,
                priceMap.get(effectiveProductId) ?? null,
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

            // Track audit entry with changes
            if (before) {
              const changes = computeChanges(before, updated, [
                "amount",
                "productId",
              ]);
              if (changes) {
                auditEntries.push({
                  entityType: "inventory",
                  entityId: item.id,
                  action: "update",
                  changes,
                });
              }
            }

            resultIds.push(updated.id);
          } else {
            resultIds.push(item.id);
          }
        }
      }

      // Batch log all audit entries from the loop
      if (auditEntries.length > 0) {
        await logAuditEntries(tx, actor, auditEntries);
      }

      // Batch re-fetch all results with relations
      const results = await batchFetchResults(tx, resultIds);

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
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Source and target locations must be different",
    );
  }

  // Transaction boundary: every per-item move (source decrement/delete, target
  // merge/create, audit logging, and both location timestamp bumps) commits or
  // rolls back as one unit, so a failure partway through the items never leaves
  // inventory split between source and target.
  const processedItems = await withTransaction(
    db,
    async (tx: DrizzleTransaction) => {
      // Guard: never move inventory onto a soft-deleted target location.
      await assertLiveTargets(tx, { locationId: payload.targetLocationId });

      const sourceIds = payload.items.map((i) => i.inventoryEntryId);

      // Pre-fetch all source entries in a single query
      const sourceEntries = await tx.query.inventoryEntry.findMany({
        where: inArray(inventoryEntry.id, sourceIds),
        ...relations.inventory.full,
      });
      const sourceMap = new Map(sourceEntries.map((e) => [e.id, e]));

      // Validate all source entries exist
      for (const item of payload.items) {
        if (!sourceMap.has(item.inventoryEntryId)) {
          throw createAppError(
            "INVENTORY_NOT_FOUND",
            `Inventory entry ${item.inventoryEntryId} not found`,
          );
        }
      }

      // Pre-fetch all target entries (products at target location) in a single query
      const sourceProductIds = uniq(sourceEntries.map((e) => e.productId));
      const targetEntries = await tx.query.inventoryEntry.findMany({
        where: and(
          inArray(inventoryEntry.productId, sourceProductIds),
          eq(inventoryEntry.locationId, payload.targetLocationId),
          notDeleted(inventoryEntry),
        ),
        ...relations.inventory.full,
      });
      const targetMap = new Map(targetEntries.map((e) => [e.productId, e]));

      // Pre-fetch all product prices in a single query
      const priceMap = new Map<string, number | null>();
      if (sourceProductIds.length > 0) {
        const products = await tx
          .select({ id: product.id, price: product.price })
          .from(product)
          .where(inArray(product.id, sourceProductIds));
        for (const p of products) {
          priceMap.set(p.id, p.price);
        }
      }

      // Collect result IDs and audit entries during processing
      const resultIds: string[] = [];
      const auditEntries: AuditEntryInput[] = [];

      for (const item of payload.items) {
        const sourceEntry = sourceMap.get(item.inventoryEntryId)!;

        // Parse quantities
        const parsedSourceAmount = parseInventoryAmount(
          sourceEntry.amount,
          sourceEntry.id,
        );
        const sourceQuantity = parsedSourceAmount.value;
        const moveQuantity = item.quantity.value;

        if (moveQuantity > sourceQuantity) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `Cannot move ${moveQuantity} ${item.quantity.unit} - only ${sourceQuantity} available`,
          );
        }

        const productPrice = priceMap.get(sourceEntry.productId) ?? null;
        const existingAtTarget = targetMap.get(sourceEntry.productId);

        if (moveQuantity >= sourceQuantity) {
          // Full move
          if (existingAtTarget) {
            // Merge with existing entry at target
            const existingAmount = parseInventoryAmount(
              existingAtTarget.amount,
              existingAtTarget.id,
            );
            const newQuantity = existingAmount.value + moveQuantity;
            const valuation = computeInventoryValuation(
              newQuantity,
              productPrice,
            );

            const updatedTargetEntry = await updateAndReturn(
              tx,
              inventoryEntry,
              {
                amount: { value: newQuantity, unit: item.quantity.unit },
                valuation,
              },
              eq(inventoryEntry.id, existingAtTarget.id),
            );

            const targetChanges = computeChanges(
              existingAtTarget,
              updatedTargetEntry,
              ["amount"],
            );
            if (targetChanges) {
              auditEntries.push({
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

            auditEntries.push({
              entityType: "inventory",
              entityId: item.inventoryEntryId,
              action: "delete",
            });

            resultIds.push(existingAtTarget.id);
          } else {
            // Just update location of existing entry
            const updatedEntry = await updateAndReturn(
              tx,
              inventoryEntry,
              { locationId: payload.targetLocationId },
              eq(inventoryEntry.id, item.inventoryEntryId),
            );

            const locationChanges = computeChanges(sourceEntry, updatedEntry, [
              "locationId",
            ]);
            if (locationChanges) {
              auditEntries.push({
                entityType: "inventory",
                entityId: item.inventoryEntryId,
                action: "update",
                changes: locationChanges,
              });
            }

            resultIds.push(item.inventoryEntryId);
          }
        } else {
          // Partial move - reduce source and create/update target
          const remainingQuantity = sourceQuantity - moveQuantity;
          const sourceValuation = computeInventoryValuation(
            remainingQuantity,
            productPrice,
          );

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

          const sourceChanges = computeChanges(sourceEntry, updatedSource, [
            "amount",
          ]);
          if (sourceChanges) {
            auditEntries.push({
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
            const newQuantity = existingAmount.value + moveQuantity;
            const targetValuation = computeInventoryValuation(
              newQuantity,
              productPrice,
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

            const targetChanges = computeChanges(
              existingAtTarget,
              updatedTargetEntry,
              ["amount"],
            );
            if (targetChanges) {
              auditEntries.push({
                entityType: "inventory",
                entityId: existingAtTarget.id,
                action: "update",
                changes: targetChanges,
              });
            }

            resultIds.push(existingAtTarget.id);
          } else {
            // Create new entry at target
            const valuation = computeInventoryValuation(
              item.quantity.value,
              productPrice,
            );

            const created = await insertAndReturn(tx, inventoryEntry, {
              productId: sourceEntry.productId,
              locationId: payload.targetLocationId,
              amount: item.quantity,
              valuation,
            });

            auditEntries.push({
              entityType: "inventory",
              entityId: created.id,
              action: "create",
            });

            resultIds.push(created.id);
          }
        }
      }

      // Batch log all audit entries
      if (auditEntries.length > 0) {
        await logAuditEntries(tx, actor, auditEntries);
      }

      // Batch re-fetch all results with relations
      const results = await batchFetchResults(tx, resultIds);

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
