import type { ActorContext } from "@cubby/schemas/context";
import type {
  InventoryId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type {
  InventoryBulkAddItem,
  InventoryBulkOperationItem,
  InventoryPlacement,
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
import { stockOnly } from "./placement";
import type { InventoryEntryDeepDB } from "./types";
import { loadValuationGraphs } from "./valuation";

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
      resultIds.map((id) => parseEntityId("inventory", id)),
    ),
    ...relations.inventory.full,
  });
  const fetchedById = new Map<string, InventoryEntryDeepDB>(
    fetched.map((r) => [r.id, r]),
  );
  return resultIds
    .map((id) => fetchedById.get(id))
    .filter((r): r is InventoryEntryDeepDB => r != null);
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

const validateBulkInventoryTargets = async (
  tx: DrizzleTransaction,
  locationId: LocationId,
  items: ResolvedInventoryBulkOperationItem[],
  loadedAt?: Date,
) => {
  await assertLiveTargets(tx, { locationId });
  if (loadedAt) {
    const [staleRow] = await tx
      .select({ latest: max(inventoryEntry.updatedAt) })
      .from(inventoryEntry)
      .where(eq(inventoryEntry.locationId, locationId));
    if (staleRow?.latest && staleRow.latest > loadedAt) {
      throw createAppError(
        "INVENTORY_STALE",
        "Inventory at this location changed since you loaded it — refresh and try again.",
      );
    }
  }
  const productIds = uniq(
    items.flatMap((item) => (item.productId ? [item.productId] : [])),
  );
  if (productIds.length === 0) return;
  const liveProducts = await tx
    .select({ id: product.id })
    .from(product)
    .where(and(inArray(product.id, productIds), notDeleted(product)));
  const liveIds = new Set(liveProducts.map((row) => row.id));
  const missing = productIds.find((id) => !liveIds.has(id));
  if (missing) {
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      `Product ${missing} does not exist or has been deleted`,
    );
  }
};

const deleteOmittedBulkInventory = async (
  tx: DrizzleTransaction,
  existing: InventoryEntryDeepDB[],
  items: ResolvedInventoryBulkOperationItem[],
  actor: ActorContext,
) => {
  const submittedIds = new Set(
    items.flatMap((item) => (item.id ? [item.id] : [])),
  );
  const ids = existing
    .filter((item) => !submittedIds.has(item.id))
    .map((item) => item.id);
  if (ids.length === 0) return;
  await tx
    .update(inventoryEntry)
    .set({ deletedAt: new Date() })
    .where(and(inArray(inventoryEntry.id, ids), notDeleted(inventoryEntry)));
  await cascadeRemoval(tx, {
    entity: "inventory",
    ids,
    audit: { actor },
  });
};

const processBulkInventoryItem = async (
  tx: DrizzleTransaction,
  locationId: LocationId,
  item: ResolvedInventoryBulkOperationItem,
  existingById: Map<string, InventoryEntryDeepDB>,
  valuationGraphs: Awaited<ReturnType<typeof loadValuationGraphs>>,
): Promise<{ id: string; audit?: AuditEntryInput }> => {
  if (!item.id) {
    if (!item.productId || !item.amount) {
      throw createAppError(
        "REQUIRED_FIELD_MISSING",
        "productId and amount are required for new items",
      );
    }
    const created = await insertWithShortcode(tx, "inventory", {
      productId: item.productId,
      locationId,
      amount: item.amount,
      valuation: computeInventoryValuation(
        item.amount,
        valuationGraphs.get(item.productId) ?? [],
      ),
    });
    return {
      id: created.id,
      audit: {
        entityType: "inventory",
        entityId: created.id,
        action: "create",
      },
    };
  }
  const before = existingById.get(item.id);
  const effectiveProductId = item.productId ?? before?.productId;
  const effectiveAmount = item.amount ?? before?.amount;
  const valuation =
    (item.amount !== undefined || item.productId !== undefined) &&
    effectiveProductId &&
    effectiveAmount
      ? computeInventoryValuation(
          effectiveAmount,
          valuationGraphs.get(effectiveProductId) ?? [],
        )
      : undefined;
  const values = buildPartialUpdateValues({
    amount: item.amount,
    productId: item.productId,
    valuation,
  });
  if (Object.keys(values).length === 0) return { id: item.id };
  const updated = await updateAndReturn(
    tx,
    inventoryEntry,
    values,
    eq(inventoryEntry.id, item.id),
  );
  const changes = before
    ? computeChanges(before, updated, ["amount", "productId"])
    : null;
  return {
    id: updated.id,
    audit: changes
      ? {
          entityType: "inventory",
          entityId: item.id,
          action: "update",
          changes,
        }
      : undefined,
  };
};

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
      await validateBulkInventoryTargets(tx, locationId, items, loadedAt);

      // Stock only, because this reconcile is DELETE-ON-OMIT: anything at the
      // location that the caller did not resubmit gets removed. A fixture is
      // outside this flow's jurisdiction — the bulk-capture UI never shows one,
      // so every submission would silently omit it and delete it.
      //
      // Deliberately asymmetric with the max(updatedAt) scan above, which stays
      // wide (it even includes soft-deleted rows on purpose). Over-broad there
      // costs a spurious refresh; over-narrow here costs the fixture.
      const existingItems = await tx.query.inventoryEntry.findMany({
        where: and(
          eq(inventoryEntry.locationId, locationId),
          stockOnly(),
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
      const valuationGraphs = await loadValuationGraphs(tx, allProductIds);

      // Soft-delete items not in the submitted array. This is a delete-on-omit
      // reconcile, so it MUST honor the repo-wide soft-delete invariant (set
      // deletedAt, keep the row + audit trail) — a hard delete here makes an
      // omitted entry unrecoverable, and "restore is intentionally not
      // implemented" (AGENTS.md). NOTE: bulkMoveInventoryEntries' source
      // collapse below intentionally stays a hard delete — soft-deleting a
      // fully-moved source would leave a zero-qty ghost that notDeleted() hides
      // but valuation/duplicate scans resurface.
      await deleteOmittedBulkInventory(tx, existingItems, items, actor);

      const resultIds: string[] = [];
      const auditEntries: AuditEntryInput[] = [];

      for (const item of items) {
        const result = await processBulkInventoryItem(
          tx,
          locationId,
          item,
          existingItemsMap,
          valuationGraphs,
        );
        resultIds.push(result.id);
        if (result.audit) auditEntries.push(result.audit);
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

/**
 * A row's identity in the partial unique index
 * `(productId, locationId, placement)`.
 *
 * Placement is part of the key because a spare on the shelf and one wired into
 * the wall are two legitimate rows for one product in one room. Drop it and the
 * planner collapses them into a single slot, so a move silently folds stock
 * into the fixture and hard-deletes the source — no error, no audit trail.
 */
const slotKey = (
  productId: ProductId,
  locationId: LocationId,
  placement: InventoryPlacement,
) => `${productId}:${locationId}:${placement}`;

type ResolvedInventoryBulkAddItem = {
  productId: ProductId;
  amount: InventoryBulkAddItem["amount"];
  placement?: InventoryPlacement;
};

export type ResolvedInventoryBulkAddPayload = {
  locationId: LocationId;
  items: ResolvedInventoryBulkAddItem[];
};

/**
 * Stock many products at one location, additively, in one transaction.
 *
 * Deliberately NOT built on {@link bulkProcessInventoryEntries}: that one is
 * DELETE-ON-OMIT — it reconciles a whole shelf against exactly the items
 * submitted, so a caller that only names the products it wants to add would
 * have every other row at the location soft-deleted out from under it (see
 * the comment above `bulkProcessInventoryEntries`, ~line 170). This flow only
 * ever creates or sums into the rows its own items name; everything else at
 * the location is untouched.
 *
 * An item whose slot `(productId, locationId, placement)` is already occupied
 * sums into that row rather than colliding with the partial unique index;
 * placement is part of the slot on purpose (see {@link slotKey}), so an item
 * targeting stock never merges into — or disturbs — an installed fixture of
 * the same product.
 */
export const addInventoryEntries = async (
  db: Database,
  payload: ResolvedInventoryBulkAddPayload,
  actor: ActorContext,
) => {
  const { locationId, items } = payload;

  const processed = await withTransaction(
    db,
    async (tx: DrizzleTransaction) => {
      await assertLiveTargets(tx, { locationId });

      const submittedProductIds = uniq(items.map((item) => item.productId));
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

      // A product listed twice for the same slot would collide with itself —
      // there is no way to tell which item's unit or amount should win — so
      // refuse the whole request rather than silently picking one.
      const seenSlots = new Set<string>();
      for (const item of items) {
        const key = slotKey(
          item.productId,
          locationId,
          item.placement ?? "stock",
        );
        if (seenSlots.has(key)) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `Product ${item.productId} is listed more than once for this location`,
          );
        }
        seenSlots.add(key);
      }

      // Every live row this request could land on — any placement, so an
      // existing installed fixture is visible for the slotKey check below even
      // though nothing here will ever write to it unless an item explicitly asks
      // for placement "installed".
      const existingItems =
        submittedProductIds.length > 0
          ? await tx.query.inventoryEntry.findMany({
              where: and(
                eq(inventoryEntry.locationId, locationId),
                inArray(inventoryEntry.productId, submittedProductIds),
                notDeleted(inventoryEntry),
              ),
              ...relations.inventory.full,
            })
          : [];
      const existingBySlot = new Map(
        existingItems.map((entry) => [
          slotKey(entry.productId, entry.locationId, entry.placement),
          entry,
        ]),
      );

      const valuationGraphs = await loadValuationGraphs(
        tx,
        submittedProductIds,
      );

      const resultIds: string[] = [];
      const auditEntries: AuditEntryInput[] = [];
      let createdCount = 0;
      let mergedCount = 0;

      for (const item of items) {
        const placement = item.placement ?? "stock";
        const existing = existingBySlot.get(
          slotKey(item.productId, locationId, placement),
        );

        if (existing) {
          const before = parseInventoryAmount(existing.amount, existing.id);
          // Same wording/shape as the merge-unit guard in moveInventoryEntries
          // above: summing `each` into `lb` produces a number that means
          // nothing, so refuse rather than pick a unit.
          if (before.unit !== item.amount.unit) {
            throw createAppError(
              "CONSTRAINT_VIOLATION",
              `Cannot add ${item.amount.unit} to ${before.unit}: the existing entry for product ${item.productId} carries a different unit. Reconcile the units before adding.`,
            );
          }

          const nextAmount = {
            value: before.value + item.amount.value,
            unit: before.unit,
          };
          const valuation = computeInventoryValuation(
            nextAmount,
            valuationGraphs.get(item.productId) ?? [],
          );
          const updated = await updateAndReturn(
            tx,
            inventoryEntry,
            { amount: nextAmount, valuation },
            eq(inventoryEntry.id, existing.id),
          );
          const changes = computeChanges(existing, updated, ["amount"]);
          if (changes) {
            auditEntries.push({
              entityType: "inventory",
              entityId: existing.id,
              action: "update",
              changes,
            });
          }
          resultIds.push(updated.id);
          mergedCount += 1;
        } else {
          const valuation = computeInventoryValuation(
            item.amount,
            valuationGraphs.get(item.productId) ?? [],
          );
          const values: Parameters<typeof insertWithShortcode<"inventory">>[2] =
            {
              productId: item.productId,
              locationId,
              amount: item.amount,
              valuation,
            };
          if (item.placement) values.placement = item.placement;
          const created = await insertWithShortcode(tx, "inventory", values);
          resultIds.push(created.id);
          auditEntries.push({
            entityType: "inventory",
            entityId: created.id,
            action: "create",
          });
          createdCount += 1;
        }
      }

      if (auditEntries.length > 0) {
        await logAuditEntries(tx, actor, auditEntries);
      }

      const results = await batchFetchResults(tx, resultIds);

      // Deliberately does NOT stamp `location.lastBulkInventory` (see the NOTE
      // on `moveInventoryEntries` below, ~line 730): only an explicit audit
      // completion marks a location audited, so stocking in a delivery can't
      // make a bin read "audited" with zero recount.
      return { results, createdCount, mergedCount };
    },
  );

  const pricing = await loadInventoryEntryPricing(db, processed.results);
  return {
    items: processed.results.map((entry) =>
      dbInventoryEntryToAPI(
        entry,
        requireLoadedProductPricing(pricing, entry.product.id),
      ),
    ),
    createdCount: processed.createdCount,
    mergedCount: processed.mergedCount,
  };
};

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
  placement: InventoryPlacement;
  value: number;
  unit: string;
  /** The row as loaded, for `computeChanges`. Null for a row this move creates. */
  original: InventoryEntryDeepDB | null;
};

type InventoryMovePlan = {
  plannedBySlot: Map<string, PlannedRow>;
  slotByEntryId: Map<InventoryId, string>;
};

const buildInventoryMovePlan = (
  sourceEntries: InventoryEntryDeepDB[],
  destinationEntries: InventoryEntryDeepDB[],
): InventoryMovePlan => {
  const plannedBySlot = new Map<string, PlannedRow>();
  for (const entry of [...sourceEntries, ...destinationEntries]) {
    const key = slotKey(entry.productId, entry.locationId, entry.placement);
    if (plannedBySlot.has(key)) continue;
    const parsed = parseInventoryAmount(entry.amount, entry.id);
    plannedBySlot.set(key, {
      id: entry.id,
      productId: entry.productId,
      locationId: entry.locationId,
      placement: entry.placement,
      value: parsed.value,
      unit: parsed.unit,
      original: entry,
    });
  }
  return {
    plannedBySlot,
    slotByEntryId: new Map(
      sourceEntries.map((entry) => [
        entry.id,
        slotKey(entry.productId, entry.locationId, entry.placement),
      ]),
    ),
  };
};

const assertMoveUnitsMatch = (
  movingUnit: string,
  source: PlannedRow,
  target: PlannedRow | undefined,
) => {
  for (const [label, unit] of [
    ["the entry", source.unit],
    ["the destination", target?.unit],
  ] as const) {
    if (unit !== undefined && unit !== movingUnit) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Cannot move ${movingUnit} into ${unit}: ${label} carries a different unit. Reconcile the units before moving.`,
      );
    }
  }
};

const applyInventoryMoveItem = (
  plan: InventoryMovePlan,
  item: ResolvedMoveInventoryEntriesPayload["items"][number],
): string => {
  const sourceSlot = plan.slotByEntryId.get(item.inventoryEntryId);
  const source = sourceSlot ? plan.plannedBySlot.get(sourceSlot) : undefined;
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
  const targetSlot = slotKey(
    source.productId,
    item.targetLocationId,
    source.placement,
  );
  const target = plan.plannedBySlot.get(targetSlot);
  const movingUnit = item.quantity?.unit ?? source.unit;
  assertMoveUnitsMatch(movingUnit, source, target);
  const remaining = source.value - moveQuantity;
  if (remaining === 0 && target) {
    target.value += moveQuantity;
    plan.plannedBySlot.delete(sourceSlot);
    plan.slotByEntryId.delete(item.inventoryEntryId);
  } else if (remaining === 0) {
    plan.plannedBySlot.delete(sourceSlot);
    source.locationId = item.targetLocationId;
    plan.plannedBySlot.set(targetSlot, source);
    plan.slotByEntryId.set(item.inventoryEntryId, targetSlot);
  } else {
    source.value = remaining;
    if (target) target.value += moveQuantity;
    else {
      plan.plannedBySlot.set(targetSlot, {
        id: null,
        productId: source.productId,
        locationId: item.targetLocationId,
        placement: source.placement,
        value: moveQuantity,
        unit: movingUnit,
        original: null,
      });
    }
  }
  return targetSlot;
};

const persistInventoryMovePlan = async (
  tx: DrizzleTransaction,
  payload: ResolvedMoveInventoryEntriesPayload,
  sourceEntries: InventoryEntryDeepDB[],
  destinationEntries: InventoryEntryDeepDB[],
  plan: InventoryMovePlan,
  resultSlots: string[],
  valuationGraphs: Awaited<ReturnType<typeof loadValuationGraphs>>,
  actor: ActorContext,
) => {
  const auditEntries: AuditEntryInput[] = [];
  const hardDeletedSourceIds: InventoryId[] = [];
  const idBySlot = new Map<string, InventoryId>();
  const sourceById = new Map(sourceEntries.map((entry) => [entry.id, entry]));
  const occupantBySlot = new Map<string, InventoryId>(
    [...sourceEntries, ...destinationEntries].map((entry) => [
      slotKey(entry.productId, entry.locationId, entry.placement),
      entry.id,
    ]),
  );
  for (const item of payload.items) {
    if (plan.slotByEntryId.has(item.inventoryEntryId)) continue;
    const entry = sourceById.get(item.inventoryEntryId);
    if (!entry || hardDeletedSourceIds.includes(entry.id)) continue;
    await tx.delete(inventoryEntry).where(eq(inventoryEntry.id, entry.id));
    hardDeletedSourceIds.push(entry.id);
    occupantBySlot.delete(
      slotKey(entry.productId, entry.locationId, entry.placement),
    );
  }
  const pending = [...plan.plannedBySlot];
  while (pending.length > 0) {
    const ready = pending.filter(([key, row]) => {
      const occupant = occupantBySlot.get(key);
      return occupant === undefined || occupant === row.id;
    });
    if (ready.length === 0) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "This move swaps a product between locations in a single request, which cannot be applied without an intermediate state. Split it into two calls.",
      );
    }
    for (const [key, row] of ready) {
      const valuation = computeInventoryValuation(
        { value: row.value, unit: row.unit },
        valuationGraphs.get(row.productId) ?? [],
      );
      if (row.id === null) {
        const created = await insertWithShortcode(tx, "inventory", {
          productId: row.productId,
          locationId: row.locationId,
          placement: row.placement,
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
      if (!row.original) {
        throw new Error(`Planned inventory row ${row.id} has no original`);
      }
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
        slotKey(
          row.original.productId,
          row.original.locationId,
          row.original.placement,
        ),
      );
      occupantBySlot.set(key, row.id);
      const changes = computeChanges(row.original, updated, [
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
  await cascadeRemoval(tx, {
    entity: "inventory",
    ids: hardDeletedSourceIds,
    audit: { into: auditEntries },
  });
  if (auditEntries.length > 0) await logAuditEntries(tx, actor, auditEntries);
  return resultSlots.flatMap((key) => {
    const id = idBySlot.get(key);
    return id ? [id] : [];
  });
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

      const valuationGraphs = await loadValuationGraphs(tx, productIds);

      const plan = buildInventoryMovePlan(sourceEntries, destinationEntries);
      // Destination slots in request order — the response echoes the rows the
      // caller asked to fill, deduped, not every row the plan touched.
      const resultSlots: string[] = [];

      for (const item of payload.items) {
        const targetSlot = applyInventoryMoveItem(plan, item);
        if (!resultSlots.includes(targetSlot)) resultSlots.push(targetSlot);
      }

      // Persist only after the complete in-memory plan is valid. Consumed rows
      // are deleted first to free unique slots, then the remaining DAG writes.
      const resultIds = await persistInventoryMovePlan(
        tx,
        payload,
        sourceEntries,
        destinationEntries,
        plan,
        resultSlots,
        valuationGraphs,
        actor,
      );
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
      //
      // BOTH queries are stock-only, and they must stay that way TOGETHER.
      // Installed fixtures are outside a recount's jurisdiction, so the client
      // never counts them (`getInventoryByLocationIds` with placement "stock").
      // If `existing` were narrowed and this `max(updatedAt)` were not, merely
      // editing a fixture's amount would raise the server's watermark above the
      // client's and throw INVENTORY_STALE on every recount at that location,
      // with no visible cause and no way for the operator to clear it.
      //
      // The converse — flipping a row stock→installed mid-session — SHOULD
      // throw: the row leaves `liveIds` while still in `expectedIds`, so the
      // snapshot genuinely changed. That is asserted, not accidental.
      const existing = await tx.query.inventoryEntry.findMany({
        where: and(
          eq(inventoryEntry.locationId, locationId),
          stockOnly(),
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
            stockOnly(),
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
      const valuationGraphs = await loadValuationGraphs(tx, changedProductIds);

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
                placement: inventoryEntry.placement,
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
      // Keyed by placement too, or a relocate folds a stock row into a fixture
      // of the same product at the destination and hard-deletes the source —
      // silent data loss with no error.
      const targetRowsByLocationProduct = new Map(
        targetRows.map((entry) => [
          `${entry.locationId}:${entry.productId}:${entry.placement}`,
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
              adjusted,
              valuationGraphs.get(before.productId) ?? [],
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
            const auditEntry: AuditEntryInput = {
              entityType: "inventory",
              entityId: before.id,
              action: "update",
            };
            if (changes) auditEntry.changes = changes;
            auditEntries.push(auditEntry);
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
            const targetKey = `${targetLocationId}:${before.productId}:${before.placement}`;
            const target = targetRowsByLocationProduct.get(targetKey);
            const valuationGraph = valuationGraphs.get(before.productId) ?? [];

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
                    nextAmount,
                    valuationGraph,
                  ),
                  verifiedAt: now,
                },
                eq(inventoryEntry.id, target.id),
              );
              const targetChanges = computeChanges(target, updatedTarget, [
                "amount",
              ]);
              const auditEntry: AuditEntryInput = {
                entityType: "inventory",
                entityId: target.id,
                action: "update",
              };
              if (targetChanges) auditEntry.changes = targetChanges;
              auditEntries.push(auditEntry);
              await tx
                .delete(inventoryEntry)
                .where(eq(inventoryEntry.id, before.id));
              removedIds.push(before.id);
              resultIds.push(updatedTarget.id);
              targetRowsByLocationProduct.set(targetKey, {
                id: updatedTarget.id,
                productId: updatedTarget.productId,
                locationId: updatedTarget.locationId,
                placement: updatedTarget.placement,
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
              const auditEntry: AuditEntryInput = {
                entityType: "inventory",
                entityId: before.id,
                action: "update",
              };
              if (changes) auditEntry.changes = changes;
              auditEntries.push(auditEntry);
              resultIds.push(updated.id);
              targetRowsByLocationProduct.set(targetKey, {
                id: updated.id,
                productId: updated.productId,
                locationId: updated.locationId,
                placement: updated.placement,
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
