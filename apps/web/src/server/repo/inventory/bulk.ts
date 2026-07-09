import type { ActorContext } from "@cubby/schemas/context";
import type {
  InventoryId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { unsafeInventoryId } from "@cubby/schemas/identifiers";
import type {
  BulkMovePayload,
  InventoryBulkOperationItem,
  InventorySessionResolution,
} from "@cubby/schemas/inventory";
import { and, eq, inArray, max } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { match } from "ts-pattern";
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
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding";
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
  // When the client passes the time it loaded the snapshot, reject the commit if
  // anything at the location changed since — this form deletes-on-omit, so a stale
  // snapshot would silently delete entries another surface added after load.
  loadedAt?: Date,
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

      // Staleness guard: max(updatedAt) over ALL rows at the location (including
      // soft-deleted — a delete bumps updatedAt too), so this single scalar
      // catches an add / edit / delete that landed after the client loaded.
      if (loadedAt) {
        const staleRows = await tx
          .select({ latest: max(inventoryEntry.updatedAt) })
          .from(inventoryEntry)
          .where(eq(inventoryEntry.locationId, locationId));
        const latest = staleRows[0]?.latest ?? null;
        if (latest && latest > loadedAt) {
          throw createAppError(
            "INVENTORY_STALE",
            "Inventory at this location changed since you loaded it — refresh and try again.",
          );
        }
      }

      const submittedProductIds = uniq(
        items.filter((i) => i.productId).map((i) => i.productId),
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
        ...items.filter((i) => i.productId).map((i) => i.productId),
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

      // Soft-delete items not in the submitted array. This is a delete-on-omit
      // reconcile, so it MUST honor the repo-wide soft-delete invariant (set
      // deletedAt, keep the row + audit trail) — a hard delete here makes an
      // omitted entry unrecoverable, and "restore is intentionally not
      // implemented" (CLAUDE.md). NOTE: bulkMoveInventoryEntries' source
      // collapse below intentionally stays a hard delete — soft-deleting a
      // fully-moved source would leave a zero-qty ghost that notDeleted() hides
      // but valuation/duplicate scans resurface.
      if (itemsToDelete.length > 0) {
        const idsToDelete = itemsToDelete.map((item) => item.id);
        await tx
          .update(inventoryEntry)
          .set({ deletedAt: new Date() })
          .where(
            and(
              inArray(inventoryEntry.id, idsToDelete),
              notDeleted(inventoryEntry),
            ),
          );

        // Cascade the search embedding in-tx: the inventory manifest has
        // onDelete: [], so this delete-on-omit reconcile is the only cleanup
        // site — without it a removed entry leaves a live EntityEmbedding
        // orphan (recall degradation + HNSW bloat). Mirrors deleteInventoryEntries.
        await softDeleteEntityEmbeddingsTx(tx, "inventory", idsToDelete);

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
        where: and(
          inArray(inventoryEntry.id, sourceIds),
          notDeleted(inventoryEntry),
        ),
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
      // Source entries hard-deleted by a full move onto an existing target row
      // (the collapse below). Their embeddings must be cleaned up in-tx too.
      const hardDeletedSourceIds: InventoryId[] = [];

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
            hardDeletedSourceIds.push(item.inventoryEntryId);

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

      // Cascade the search embeddings of collapsed source rows. Invariant: the
      // source row is HARD-deleted (no FK, permanently gone), so we deliberately
      // soft-delete its embedding via the shared cascade helper rather than add a
      // hard-delete path — a soft-deleted embedding is excluded from both semantic
      // search and orphan detection, and reusing one helper keeps every removal
      // path's embedding cleanup uniform.
      await softDeleteEntityEmbeddingsTx(tx, "inventory", hardDeletedSourceIds);

      // Batch log all audit entries
      if (auditEntries.length > 0) {
        await logAuditEntries(tx, actor, auditEntries);
      }

      // Batch re-fetch all results with relations
      const results = await batchFetchResults(tx, resultIds);

      // NOTE: a move no longer stamps `lastBulkInventory` — only an explicit
      // audit completion (`completeLocationAudit`) marks a location audited, so
      // relocating one item can't make a bin read "audited" with zero recount.
      return results;
    },
  );

  return processedItems.map(dbInventoryEntryToAPI);
};

/**
 * Commit a location's recount as one atomic diff, then stamp the location's
 * `lastBulkInventory`. Each resolution is one staged decision about an expected
 * row: `verify` records `verifiedAt`; `adjust` updates the amount (+ valuation +
 * `verifiedAt`); `remove` soft-deletes. Verify is a pure audit signal — only
 * adjust/remove change inventory, so `recomputeNeeded` tells the caller whether
 * to dispatch a valuation recompute. Relocations flow through `bulkMove`. Ids
 * that don't live at this location (stale / foreign) are ignored.
 */
export const reconcileLocationSession = async (
  db: Database,
  locationId: LocationId,
  resolutions: InventorySessionResolution[],
  actor: ActorContext,
) => {
  const { processed, removedIds, recomputeNeeded } = await withTransaction(
    db,
    async (tx: DrizzleTransaction) => {
      await assertLiveTargets(tx, { locationId });
      const now = new Date();
      const ids = uniq(resolutions.map((r) => r.inventoryEntryId));

      const existing =
        ids.length > 0
          ? await tx.query.inventoryEntry.findMany({
              where: and(
                inArray(inventoryEntry.id, ids),
                eq(inventoryEntry.locationId, locationId),
                notDeleted(inventoryEntry),
              ),
              ...relations.inventory.full,
            })
          : [];
      const existingById = new Map(existing.map((e) => [e.id, e]));

      // Prices for adjusted entries' products (to recompute valuation).
      const adjustProductIds = uniq(
        resolutions
          .filter((r) => r.kind === "adjust")
          .map((r) => existingById.get(r.inventoryEntryId)?.productId)
          .filter((id): id is ProductId => id != null),
      );
      const priceMap = new Map<string, number | null>();
      if (adjustProductIds.length > 0) {
        const products = await tx
          .select({ id: product.id, price: product.price })
          .from(product)
          .where(inArray(product.id, adjustProductIds));
        for (const p of products) priceMap.set(p.id, p.price);
      }

      const auditEntries: AuditEntryInput[] = [];
      const resultIds: string[] = [];
      const removedIds: InventoryId[] = [];
      let recomputeNeeded = false;

      for (const r of resolutions) {
        const before = existingById.get(r.inventoryEntryId);
        if (!before) continue;

        // Exhaustive match so a future resolution kind is a compile error, not a
        // silent fall-through to the (destructive) delete branch.
        await match(r)
          .with({ kind: "verify" }, async () => {
            await tx
              .update(inventoryEntry)
              .set({ verifiedAt: now })
              .where(eq(inventoryEntry.id, before.id));
            resultIds.push(before.id);
            auditEntries.push({
              entityType: "inventory",
              entityId: before.id,
              action: "update",
            });
          })
          .with({ kind: "adjust" }, async ({ amount: adjusted }) => {
            const valuation = computeInventoryValuation(
              adjusted.value,
              priceMap.get(before.productId) ?? null,
            );
            const updated = await updateAndReturn(
              tx,
              inventoryEntry,
              { amount: adjusted, valuation, verifiedAt: now },
              eq(inventoryEntry.id, before.id),
            );
            recomputeNeeded = true;
            resultIds.push(updated.id);
            const changes = computeChanges(before, updated, ["amount"]);
            auditEntries.push({
              entityType: "inventory",
              entityId: before.id,
              action: "update",
              ...(changes ? { changes } : {}),
            });
          })
          .with({ kind: "remove" }, async () => {
            await tx
              .update(inventoryEntry)
              .set({ deletedAt: now })
              .where(eq(inventoryEntry.id, before.id));
            recomputeNeeded = true;
            removedIds.push(before.id);
            auditEntries.push({
              entityType: "inventory",
              entityId: before.id,
              action: "delete",
            });
          })
          .exhaustive();
      }

      // Cascade the search embeddings of removed rows in-tx (inventory manifest
      // has onDelete: [], so this reconcile is the only cleanup site).
      await softDeleteEntityEmbeddingsTx(tx, "inventory", removedIds);

      await tx
        .update(location)
        .set({ lastBulkInventory: now })
        .where(eq(location.id, locationId));
      if (auditEntries.length > 0) {
        await logAuditEntries(tx, actor, auditEntries);
      }

      const processed = await batchFetchResults(tx, resultIds);
      return { processed, removedIds, recomputeNeeded };
    },
  );

  return {
    items: processed.map(dbInventoryEntryToAPI),
    removedIds,
    recomputeNeeded,
  };
};
