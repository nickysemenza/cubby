import type { ActorContext } from "@cubby/schemas/context";
import type {
  InventoryId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { unsafeInventoryId } from "@cubby/schemas/identifiers";
import type { InventoryBulkOperationItem } from "@cubby/schemas/inventory";
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
  notDeleted,
  parseInventoryAmount,
  relations,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { loadProductPricing } from "~/server/repo/product/pricing";
import { cascadeRemoval } from "~/server/repo/removal";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { assertLiveTargets } from "./helpers";
import { dbInventoryEntryToAPI, requireLoadedProductPricing } from "./mappers";
import type { InventoryEntryDeepDB } from "./types";

type ResolvedInventoryBulkOperationItem = Omit<
  InventoryBulkOperationItem,
  "id" | "productId" | "locationId"
> & {
  id?: InventoryId;
  productId: ProductId;
  locationId: LocationId;
};

export type ResolvedBulkMovePayload = {
  sourceLocationId: LocationId;
  targetLocationId: LocationId;
  items: Array<{
    inventoryEntryId: InventoryId;
    quantity: InventoryBulkOperationItem["amount"];
  }>;
};

export type ResolvedReconcileSessionPayload = {
  locationId: LocationId;
  expectedInventoryEntryIds: InventoryId[];
  snapshotUpdatedAt: Date | null;
  resolutions: Array<
    | { kind: "verify"; inventoryEntryId: InventoryId }
    | {
        kind: "adjust";
        inventoryEntryId: InventoryId;
        amount: InventoryBulkOperationItem["amount"];
      }
    | { kind: "remove"; inventoryEntryId: InventoryId }
    | {
        kind: "relocate";
        inventoryEntryId: InventoryId;
        targetLocationId: LocationId;
      }
  >;
};

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

const loadInventoryEntryPricing = async (
  db: Database,
  entries: ReadonlyArray<InventoryEntryDeepDB>,
) =>
  loadProductPricing(
    db,
    entries.map((entry) => ({
      id: entry.product.id,
      price: entry.product.price,
    })),
  );

export const bulkProcessInventoryEntries = async (
  db: Database,
  locationId: LocationId,
  items: ResolvedInventoryBulkOperationItem[],
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

      const existingItems = await tx.query.inventoryEntry.findMany({
        where: and(
          eq(inventoryEntry.locationId, locationId),
          notDeleted(inventoryEntry),
        ),
        ...relations.inventory.full,
      });

      const existingItemsMap = new Map(
        existingItems.map((item) => [item.id, item]),
      );

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
        const pricing = await loadProductPricing(tx, products);
        for (const p of products) {
          priceMap.set(p.id, pricing.get(p.id)?.effectivePrice ?? null);
        }
      }

      const submittedIds = items
        .filter((item) => item.id)
        .map((item) => item.id as string);

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

        // The inventory manifest has onDelete: [], so this delete-on-omit
        // reconcile is the only cleanup site for these entries' embeddings.
        await cascadeRemoval(tx, {
          entity: "inventory",
          ids: idsToDelete,
          audit: { actor },
        });
      }

      const resultIds: string[] = [];
      const auditEntries: AuditEntryInput[] = [];

      for (const item of items) {
        if (!item.id) {
          if (!item.productId || !item.amount) {
            throw createAppError(
              "REQUIRED_FIELD_MISSING",
              "productId and amount are required for new items",
            );
          }

          const amountValue =
            typeof item.amount === "object" && item.amount !== null
              ? (item.amount as { value: number }).value
              : 0;
          const valuation = computeInventoryValuation(
            amountValue,
            priceMap.get(item.productId) ?? null,
          );

          const created = await insertWithShortcode(tx, "inventory", {
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
          const updateValues = buildPartialUpdateValues({
            amount: item.amount,
            productId: item.productId,
          });

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

          const finalUpdateValues = buildPartialUpdateValues({
            ...updateValues,
            valuation,
          });

          if (Object.keys(finalUpdateValues).length > 0) {
            const before = existingItemsMap.get(item.id);
            const updated = await updateAndReturn(
              tx,
              inventoryEntry,
              finalUpdateValues,
              eq(inventoryEntry.id, item.id),
            );

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

      if (auditEntries.length > 0) {
        await logAuditEntries(tx, actor, auditEntries);
      }

      const results = await batchFetchResults(tx, resultIds);

      await tx
        .update(location)
        .set({ lastBulkInventory: new Date() })
        .where(eq(location.id, locationId));

      return results;
    },
  );

  const pricing = await loadInventoryEntryPricing(db, processedItems);
  return processedItems.map((entry) =>
    dbInventoryEntryToAPI(
      entry,
      requireLoadedProductPricing(pricing, entry.product.id),
    ),
  );
};

export type ResolvedMoveInventoryEntriesPayload = {
  items: Array<{
    inventoryEntryId: InventoryId;
    targetLocationId: LocationId;
    /** Omitted = move whatever is left of the entry. */
    quantity?: InventoryBulkOperationItem["amount"];
  }>;
};

/** A row's identity in the partial unique index `(productId, locationId)`. */
const slotKey = (productId: ProductId, locationId: LocationId) =>
  `${productId}:${locationId}`;

/**
 * The in-memory ledger a move plans against before it writes anything.
 *
 * Planning in memory rather than writing per item is what makes many→many
 * safe. With a single source location the two lookups could be plain
 * pre-fetches, because `InventoryEntry_productId_locationId_key` guarantees one
 * row per product per location — so no two items could ever touch the same row.
 * Once each item carries its own target that guarantee is gone in both
 * directions: two entries of the same product moving in from different shelves
 * land on ONE destination row, and one entry split across two drawers is drawn
 * down twice. Against a stale pre-fetch the second write of either pair
 * computes from the pre-move value and silently discards the first.
 */
type PlannedRow = {
  id: InventoryId | null;
  productId: ProductId;
  locationId: LocationId;
  value: number;
  unit: string;
  /** The row as loaded, for `computeChanges`. Null for a row this move creates. */
  original: InventoryEntryDeepDB | null;
};

/**
 * Move inventory entries to per-item destinations, in one transaction.
 *
 * The general form of a move: each item names an entry and where it should end
 * up, so one call can fan a shelf out across a dozen drawers, consolidate a
 * dozen drawers onto a shelf, or both at once. `bulkMoveInventoryEntries` below
 * is the one-source/one-target special case, kept for the callers that mean it.
 *
 * Four outcomes per item, unchanged from the single-source version:
 *   - full move, nothing at the destination → the row's `locationId` moves;
 *   - full move onto an existing row       → quantities sum, source row is
 *     HARD-deleted (a soft delete would leave a zero-quantity ghost that
 *     `notDeleted()` hides but valuation and duplicate scans resurface);
 *   - partial move onto an existing row    → source draws down, destination sums;
 *   - partial move to an empty destination → source draws down, a row is minted.
 */
export const moveInventoryEntries = async (
  db: Database,
  payload: ResolvedMoveInventoryEntriesPayload,
  actor: ActorContext,
) => {
  // Transaction boundary: every row this move touches commits or rolls back as
  // one unit. That is the property the old per-source-group loop could not
  // offer — it issued one request per source location, so a failure partway
  // through left the earlier groups moved and the rest where they started.
  const processedItems = await withTransaction(
    db,
    async (tx: DrizzleTransaction) => {
      const targetLocationIds = uniq(
        payload.items.map((item) => item.targetLocationId),
      );
      // Never move inventory onto a soft-deleted location — every distinct
      // destination, not just the one the old signature could name.
      for (const locationId of targetLocationIds) {
        await assertLiveTargets(tx, { locationId });
      }

      const sourceIds = uniq(
        payload.items.map((item) => item.inventoryEntryId),
      );
      const sourceEntries = await tx.query.inventoryEntry.findMany({
        where: and(
          inArray(inventoryEntry.id, sourceIds),
          notDeleted(inventoryEntry),
        ),
        ...relations.inventory.full,
      });
      const sourceById = new Map(sourceEntries.map((e) => [e.id, e]));
      for (const id of sourceIds) {
        if (!sourceById.has(id)) {
          throw createAppError(
            "INVENTORY_NOT_FOUND",
            `Inventory entry ${id} not found`,
          );
        }
      }

      const productIds = uniq(sourceEntries.map((e) => e.productId));
      // Rows already sitting at any destination for any product in play. These
      // plus the sources are every row the plan can read or write.
      const destinationEntries =
        productIds.length > 0
          ? await tx.query.inventoryEntry.findMany({
              where: and(
                inArray(inventoryEntry.productId, productIds),
                inArray(inventoryEntry.locationId, targetLocationIds),
                notDeleted(inventoryEntry),
              ),
              ...relations.inventory.full,
            })
          : [];

      const priceMap = new Map<string, number | null>();
      if (productIds.length > 0) {
        const products = await tx
          .select({ id: product.id, price: product.price })
          .from(product)
          .where(inArray(product.id, productIds));
        const pricing = await loadProductPricing(tx, products);
        for (const p of products) {
          priceMap.set(p.id, pricing.get(p.id)?.effectivePrice ?? null);
        }
      }

      const plannedBySlot = new Map<string, PlannedRow>();
      const plan = (entry: InventoryEntryDeepDB) => {
        const parsed = parseInventoryAmount(entry.amount, entry.id);
        const key = slotKey(entry.productId, entry.locationId);
        if (plannedBySlot.has(key)) return;
        plannedBySlot.set(key, {
          id: entry.id,
          productId: entry.productId,
          locationId: entry.locationId,
          value: parsed.value,
          unit: parsed.unit,
          original: entry,
        });
      };
      for (const entry of [...sourceEntries, ...destinationEntries])
        plan(entry);

      // Where each source entry currently sits in the plan. A full move re-keys
      // its row to the destination slot, so a later item naming the same entry
      // has to follow it rather than look at where it started.
      const slotByEntryId = new Map<InventoryId, string>(
        sourceEntries.map((e) => [e.id, slotKey(e.productId, e.locationId)]),
      );
      // Destination slots in request order — the response echoes the rows the
      // caller asked to fill, deduped, not every row the plan touched.
      const resultSlots: string[] = [];

      for (const item of payload.items) {
        const sourceSlot = slotByEntryId.get(item.inventoryEntryId);
        const source = sourceSlot ? plannedBySlot.get(sourceSlot) : undefined;
        if (!sourceSlot || !source) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `Inventory entry ${item.inventoryEntryId} was already fully moved earlier in this request`,
          );
        }

        if (source.locationId === item.targetLocationId) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "Source and target locations must be different",
          );
        }

        const moveQuantity = item.quantity?.value ?? source.value;
        if (moveQuantity > source.value) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `Cannot move ${moveQuantity} ${item.quantity?.unit ?? source.unit} - only ${source.value} available`,
          );
        }

        const targetSlot = slotKey(source.productId, item.targetLocationId);
        const existingAtTarget = plannedBySlot.get(targetSlot);

        // Summing `each` into `lb` produces a number that means nothing.
        // `mergeProducts` refuses the same collision outright
        // (PRODUCT_MERGE_INVENTORY_UNIT_MISMATCH) rather than picking a unit;
        // so does this. The single-source version could not reach the case in
        // practice, since one shelf holds one row per product.
        const movingUnit = item.quantity?.unit ?? source.unit;
        for (const [label, unit] of [
          ["the entry", source.unit],
          ["the destination", existingAtTarget?.unit],
        ] as const) {
          if (unit !== undefined && unit !== movingUnit) {
            throw createAppError(
              "CONSTRAINT_VIOLATION",
              `Cannot move ${movingUnit} into ${unit}: ${label} carries a different unit. Reconcile the units before moving.`,
            );
          }
        }

        // Computed, not applied, until the branch is chosen: a full move leaves
        // the row carrying `moveQuantity` at its new slot, so decrementing up
        // front would relocate a zeroed row.
        const remaining = source.value - moveQuantity;

        if (remaining === 0 && existingAtTarget) {
          // Full move onto an occupied slot: the destination absorbs the
          // quantity and the emptied source row goes away entirely.
          existingAtTarget.value += moveQuantity;
          plannedBySlot.delete(sourceSlot);
          slotByEntryId.delete(item.inventoryEntryId);
        } else if (remaining === 0) {
          // Full move to an empty slot: the row itself relocates, keeping its
          // id, shortcode, and history — and its quantity, untouched.
          plannedBySlot.delete(sourceSlot);
          source.locationId = item.targetLocationId;
          plannedBySlot.set(targetSlot, source);
          slotByEntryId.set(item.inventoryEntryId, targetSlot);
        } else {
          source.value = remaining;
          if (existingAtTarget) {
            existingAtTarget.value += moveQuantity;
          } else {
            plannedBySlot.set(targetSlot, {
              id: null,
              productId: source.productId,
              locationId: item.targetLocationId,
              value: moveQuantity,
              unit: movingUnit,
              original: null,
            });
          }
        }

        if (!resultSlots.includes(targetSlot)) resultSlots.push(targetSlot);
      }

      const resultIds: string[] = [];
      const auditEntries: AuditEntryInput[] = [];
      const hardDeletedSourceIds: InventoryId[] = [];
      const idBySlot = new Map<string, InventoryId>();

      // Which row physically occupies each slot right now. The PLAN is always
      // consistent — it is keyed by final slot, so no two rows can end up in
      // one — but `InventoryEntry_productId_locationId_key` is a plain unique
      // index, checked per statement rather than at commit. So the order the
      // writes go out in still matters: moving a row into a slot whose previous
      // occupant has not moved out yet is a 23505 even though the end state is
      // fine.
      const occupantBySlot = new Map<string, InventoryId>();
      for (const entry of [...sourceEntries, ...destinationEntries]) {
        occupantBySlot.set(
          slotKey(entry.productId, entry.locationId),
          entry.id,
        );
      }

      // Emptied source rows go first: a delete only ever frees a slot, and
      // freeing them up front is what lets a row move into a slot the same
      // request just vacated.
      for (const item of payload.items) {
        const entry = sourceById.get(item.inventoryEntryId)!;
        if (slotByEntryId.has(item.inventoryEntryId)) continue;
        if (hardDeletedSourceIds.includes(entry.id)) continue;
        await tx.delete(inventoryEntry).where(eq(inventoryEntry.id, entry.id));
        hardDeletedSourceIds.push(entry.id);
        occupantBySlot.delete(slotKey(entry.productId, entry.locationId));
      }

      // One write and one audit entry per affected row, regardless of how many
      // items touched it — a shelf consolidating four drawers is one update to
      // the destination, not four. Rows whose destination is still occupied are
      // deferred to a later pass.
      const pending = [...plannedBySlot];
      while (pending.length > 0) {
        const ready = pending.filter(([key, row]) => {
          const occupant = occupantBySlot.get(key);
          return occupant === undefined || occupant === row.id;
        });
        if (ready.length === 0) {
          // Every remaining row is blocked by another remaining row — a cycle,
          // which needs one product to swap between locations inside a single
          // request. Breaking it would mean parking a row somewhere it does not
          // belong, so refuse instead of inventing an intermediate state.
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "This move swaps a product between locations in a single request, which cannot be applied without an intermediate state. Split it into two calls.",
          );
        }

        for (const [key, row] of ready) {
          const valuation = computeInventoryValuation(
            row.value,
            priceMap.get(row.productId) ?? null,
          );

          if (row.id === null) {
            const created = await insertWithShortcode(tx, "inventory", {
              productId: row.productId,
              locationId: row.locationId,
              amount: { value: row.value, unit: row.unit },
              valuation,
            });
            idBySlot.set(key, created.id);
            occupantBySlot.set(key, created.id);
            auditEntries.push({
              entityType: "inventory",
              entityId: created.id,
              action: "create",
            });
            continue;
          }

          const original = row.original!;
          idBySlot.set(key, row.id);
          const updated = await updateAndReturn(
            tx,
            inventoryEntry,
            {
              amount: { value: row.value, unit: row.unit },
              locationId: row.locationId,
              valuation,
            },
            eq(inventoryEntry.id, row.id),
          );
          occupantBySlot.delete(
            slotKey(original.productId, original.locationId),
          );
          occupantBySlot.set(key, row.id);
          const changes = computeChanges(original, updated, [
            "amount",
            "locationId",
          ]);
          if (changes) {
            auditEntries.push({
              entityType: "inventory",
              entityId: row.id,
              action: "update",
              changes,
            });
          }
        }
        pending.splice(
          0,
          pending.length,
          ...pending.filter((entry) => !ready.includes(entry)),
        );
      }

      for (const key of resultSlots) {
        const id = idBySlot.get(key);
        if (id) resultIds.push(id);
      }

      // Once, over every id the loop above accumulated — NOT interleaved into
      // it: those deletes run up front to free unique-index slots, and pulling
      // the cascade in with them would re-order the statements that vacate
      // `InventoryEntry_productId_locationId_key`. The source rows are HARD
      // deleted; their embeddings are still soft-deleted (see `cascadeRemoval`).
      await cascadeRemoval(tx, {
        entity: "inventory",
        ids: hardDeletedSourceIds,
        audit: { into: auditEntries },
      });

      if (auditEntries.length > 0) {
        await logAuditEntries(tx, actor, auditEntries);
      }

      // NOTE: a move no longer stamps `lastBulkInventory` — only an explicit
      // audit completion (`completeLocationAudit`) marks a location audited, so
      // relocating one item can't make a bin read "audited" with zero recount.
      return await batchFetchResults(tx, resultIds);
    },
  );

  const pricing = await loadInventoryEntryPricing(db, processedItems);
  return processedItems.map((entry) =>
    dbInventoryEntryToAPI(
      entry,
      requireLoadedProductPricing(pricing, entry.product.id),
    ),
  );
};

/**
 * Move inventory entries from one location to another.
 *
 * The one-source/one-target special case of {@link moveInventoryEntries}, kept
 * because the shelf-emptying dialog genuinely means "everything selected goes
 * from here to there" and the shared source is worth validating up front.
 */
export const bulkMoveInventoryEntries = async (
  db: Database,
  payload: ResolvedBulkMovePayload,
  actor: ActorContext,
) => {
  if (payload.sourceLocationId === payload.targetLocationId) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Source and target locations must be different",
    );
  }
  return await moveInventoryEntries(
    db,
    {
      items: payload.items.map((item) => ({
        inventoryEntryId: item.inventoryEntryId,
        targetLocationId: payload.targetLocationId,
        quantity: item.quantity,
      })),
    },
    actor,
  );
};

/**
 * Commit a location's recount as one atomic diff, then stamp the location's
 * `lastBulkInventory`. The expected-id set + row snapshot timestamp provide a
 * lightweight stale-tab guard: if the location changed after the client loaded,
 * the entire commit is rejected. Each resolution is one staged decision about an
 * expected row: `verify` records `verifiedAt`; `adjust` updates the amount (+
 * valuation + `verifiedAt`); `remove` soft-deletes; `relocate` moves the whole
 * row and merges at the destination when needed.
 */
export const reconcileLocationSession = async (
  db: Database,
  {
    locationId,
    expectedInventoryEntryIds,
    snapshotUpdatedAt,
    resolutions,
  }: ResolvedReconcileSessionPayload,
  actor: ActorContext,
) => {
  const { processed, removedIds, recomputeNeeded } = await withTransaction(
    db,
    async (tx: DrizzleTransaction) => {
      await assertLiveTargets(tx, { locationId });
      const relocationTargets = uniq(
        resolutions
          .filter((resolution) => resolution.kind === "relocate")
          .map((resolution) => resolution.targetLocationId),
      );
      for (const targetLocationId of relocationTargets) {
        if (targetLocationId === locationId) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "Relocation destination must differ from the audited location",
          );
        }
        await assertLiveTargets(tx, { locationId: targetLocationId });
      }

      const now = new Date();
      const expectedIds = uniq(expectedInventoryEntryIds);
      const resolutionIds = uniq(
        resolutions.map((resolution) => resolution.inventoryEntryId),
      );

      // Read the complete live snapshot in the transaction. Id-set equality
      // catches add/remove/move races; max(updatedAt) catches quantity/product
      // edits that leave the ids unchanged.
      const existing = await tx.query.inventoryEntry.findMany({
        where: and(
          eq(inventoryEntry.locationId, locationId),
          notDeleted(inventoryEntry),
        ),
        ...relations.inventory.full,
      });
      const latestRows = await tx
        .select({ latest: max(inventoryEntry.updatedAt) })
        .from(inventoryEntry)
        .where(
          and(
            eq(inventoryEntry.locationId, locationId),
            notDeleted(inventoryEntry),
          ),
        );
      const latest = latestRows[0]?.latest ?? null;
      const liveIds = new Set(existing.map((entry) => entry.id));
      const expectedSet = new Set(expectedIds);
      const resolutionSet = new Set(resolutionIds);
      const sameIds =
        liveIds.size === expectedSet.size &&
        [...liveIds].every((id) => expectedSet.has(id));
      const everyExpectedResolved =
        expectedSet.size === resolutionSet.size &&
        [...expectedSet].every((id) => resolutionSet.has(id));

      if (
        !sameIds ||
        !everyExpectedResolved ||
        resolutions.length !== resolutionIds.length ||
        latest?.getTime() !== snapshotUpdatedAt?.getTime()
      ) {
        throw createAppError(
          "INVENTORY_STALE",
          "Inventory at this location changed during the recount — refresh and review the bin again.",
        );
      }

      const existingById = new Map(existing.map((e) => [e.id, e]));

      // Prices for adjusted/relocated entries' products (valuation can change
      // when a relocation merges with an existing destination row).
      const changedProductIds = uniq(
        resolutions
          .filter(
            (resolution) =>
              resolution.kind === "adjust" || resolution.kind === "relocate",
          )
          .map((r) => existingById.get(r.inventoryEntryId)?.productId)
          .filter((id): id is ProductId => id != null),
      );
      const priceMap = new Map<string, number | null>();
      if (changedProductIds.length > 0) {
        const products = await tx
          .select({ id: product.id, price: product.price })
          .from(product)
          .where(inArray(product.id, changedProductIds));
        const pricing = await loadProductPricing(tx, products);
        for (const p of products) {
          priceMap.set(p.id, pricing.get(p.id)?.effectivePrice ?? null);
        }
      }

      const relocationProductIds = uniq(
        resolutions
          .filter((resolution) => resolution.kind === "relocate")
          .map(
            (resolution) =>
              existingById.get(resolution.inventoryEntryId)?.productId,
          )
          .filter((id): id is ProductId => id != null),
      );
      const targetRows =
        relocationTargets.length > 0 && relocationProductIds.length > 0
          ? await tx
              .select({
                id: inventoryEntry.id,
                productId: inventoryEntry.productId,
                locationId: inventoryEntry.locationId,
                amount: inventoryEntry.amount,
              })
              .from(inventoryEntry)
              .where(
                and(
                  inArray(inventoryEntry.locationId, relocationTargets),
                  inArray(inventoryEntry.productId, relocationProductIds),
                  notDeleted(inventoryEntry),
                ),
              )
          : [];
      const targetRowsByLocationProduct = new Map(
        targetRows.map((entry) => [
          `${entry.locationId}:${entry.productId}`,
          entry,
        ]),
      );

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
          })
          .with({ kind: "relocate" }, async ({ targetLocationId }) => {
            const sourceAmount = parseInventoryAmount(before.amount, before.id);
            const targetKey = `${targetLocationId}:${before.productId}`;
            const target = targetRowsByLocationProduct.get(targetKey);
            const productPrice = priceMap.get(before.productId) ?? null;

            if (target) {
              const targetAmount = parseInventoryAmount(
                target.amount,
                target.id,
              );
              const nextAmount = {
                value: targetAmount.value + sourceAmount.value,
                unit: sourceAmount.unit,
              };
              const updatedTarget = await updateAndReturn(
                tx,
                inventoryEntry,
                {
                  amount: nextAmount,
                  valuation: computeInventoryValuation(
                    nextAmount.value,
                    productPrice,
                  ),
                  verifiedAt: now,
                },
                eq(inventoryEntry.id, target.id),
              );
              const targetChanges = computeChanges(target, updatedTarget, [
                "amount",
              ]);
              auditEntries.push({
                entityType: "inventory",
                entityId: target.id,
                action: "update",
                ...(targetChanges ? { changes: targetChanges } : {}),
              });
              await tx
                .delete(inventoryEntry)
                .where(eq(inventoryEntry.id, before.id));
              removedIds.push(before.id);
              resultIds.push(updatedTarget.id);
              targetRowsByLocationProduct.set(targetKey, {
                id: updatedTarget.id,
                productId: updatedTarget.productId,
                locationId: updatedTarget.locationId,
                amount: updatedTarget.amount,
              });
            } else {
              const updated = await updateAndReturn(
                tx,
                inventoryEntry,
                { locationId: targetLocationId, verifiedAt: now },
                eq(inventoryEntry.id, before.id),
              );
              const changes = computeChanges(before, updated, ["locationId"]);
              auditEntries.push({
                entityType: "inventory",
                entityId: before.id,
                action: "update",
                ...(changes ? { changes } : {}),
              });
              resultIds.push(updated.id);
              targetRowsByLocationProduct.set(targetKey, {
                id: updated.id,
                productId: updated.productId,
                locationId: updated.locationId,
                amount: updated.amount,
              });
            }
            recomputeNeeded = true;
          })
          .exhaustive();
      }

      // One call over the mixed set: `remove` soft-deletes, a merge-at-
      // destination relocation hard-deletes, and both get the same soft-deleted
      // embedding — which is why no mode parameter is needed here.
      await cascadeRemoval(tx, {
        entity: "inventory",
        ids: removedIds,
        audit: { into: auditEntries },
      });

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

  const pricing = await loadInventoryEntryPricing(db, processed);
  return {
    items: processed.map((entry) =>
      dbInventoryEntryToAPI(
        entry,
        requireLoadedProductPricing(pricing, entry.product.id),
      ),
    ),
    removedIds,
    recomputeNeeded,
  };
};
