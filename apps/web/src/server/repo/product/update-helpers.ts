/**
 * Product update helper functions.
 * Private helpers used by updateProduct in crud.ts to reconcile child collections
 * (unit mappings, external IDs, images) against an incoming desired state.
 */

import {
  type ExternalIdInput,
  storedExternalIdUrl,
} from "@cubby/schemas/external-id";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import { and, asc, eq, inArray } from "drizzle-orm";
import { isCanonicalPriceMapping } from "~/lib/price-mapping-utils";
import type { DrizzleTransaction } from "~/server/db";
import {
  productExternalId,
  productImage,
  productUnitMappings,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  applyImageOrder,
  associatePendingImages,
  nextImageSortOrder,
  notDeleted,
} from "~/server/repo/database-helpers";
import { detachImagesFromEntity } from "~/server/repo/image";

/**
 * Reject a canonical "1 each <-> $X" price mapping in unit mappings.
 *
 * Per-each price lives solely on the `product.price` column (the canonical
 * costing edge is synthesized from it at read time), so a canonical row would
 * re-create the old "price is secretly a mapping" double-storage. We reject it
 * outright rather than silently relocating it (keeps submitted shape == returned
 * shape and surfaces conflicts). Per-measure money mappings (e.g. "1 quart = $4")
 * are allowed — the scalar column can't express them. Applies to every write
 * path: form, MCP tools, imports.
 */
export function assertNoCanonicalPriceMapping(
  unitMappings: UnitMappingInput[],
): void {
  if (unitMappings.some(isCanonicalPriceMapping)) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A '1 each = $X' mapping duplicates the price. Set the per-each price in the Price per Item field instead.",
    );
  }
}

/**
 * Reconcile a product's unit mappings against the desired set.
 * Mappings with no `id` are created, existing-but-absent ones are hard-deleted, and
 * matching ones are updated. Mappings stay measurement-only — the per-each price
 * lives on `product.price` and is never written here.
 *
 * It does NOT follow that mappings are valuation-neutral: `InventoryEntry.
 * valuation` routes the amount to money THROUGH this graph, so a mapping edit
 * can change every valuation for the product. `updateProduct` therefore calls
 * `syncInventoryValuationsForProduct` after this, not before.
 */
export async function syncProductUnitMappings(
  tx: DrizzleTransaction,
  productId: ProductId,
  unitMappings: UnitMappingInput[],
): Promise<void> {
  const existingMappings = await tx.query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  const toDelete = existingMappings.filter(
    (m) => !unitMappings.some((um) => um.id === m.id),
  );
  const toCreate = unitMappings.filter((m) => m.id === undefined);
  const toUpdate = unitMappings.filter(
    (m): m is UnitMappingInput & { id: string } => m.id !== undefined,
  );

  if (toDelete.length > 0) {
    await tx.delete(productUnitMappings).where(
      inArray(
        productUnitMappings.id,
        toDelete.map((m) => m.id),
      ),
    );
  }

  if (toCreate.length > 0) {
    await tx.insert(productUnitMappings).values(
      toCreate.map((mapping) => ({
        productId,
        a: mapping.a,
        b: mapping.b,
        source: mapping.source,
      })),
    );
  }

  for (const mapping of toUpdate) {
    await tx
      .update(productUnitMappings)
      .set({
        a: mapping.a,
        b: mapping.b,
        source: mapping.source,
      })
      .where(eq(productUnitMappings.id, mapping.id));
  }
}

/**
 * Guarantee every named slot still has a primary.
 *
 * The partial unique forbids TWO primaries per slot; nothing forbids ZERO — and
 * a slot with none is silently broken, because the next primary upsert's
 * arbiter (`isPrimary AND deletedAt IS NULL`) then matches no row and inserts a
 * duplicate instead of replacing.
 *
 * Every path that writes these rows ends here rather than reasoning about its
 * own ordering, because each one found a different way to drop the primary:
 * two removals from one slot, a lone demotion of the row that was primary, a
 * demote-after-overwrite, and a merge that picked a secondary as the occupant.
 * A repair keyed on live state is the only thing all four have in common.
 *
 * Promotes the OLDEST surviving row — the order the identifiers were learned in.
 */
export async function ensureSlotPrimaries(
  tx: DrizzleTransaction,
  productId: ProductId,
  slots: Iterable<{ source: string; kind: string }>,
): Promise<void> {
  const seen = new Set<string>();
  for (const slot of slots) {
    const source = slot.source.trim().toLowerCase();
    const key = `${source}\u0000${slot.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const live = await tx.query.productExternalId.findMany({
      where: and(
        eq(productExternalId.productId, productId),
        eq(productExternalId.source, source),
        eq(productExternalId.kind, slot.kind),
        notDeleted(productExternalId),
      ),
      orderBy: [asc(productExternalId.createdAt), asc(productExternalId.id)],
    });
    if (live.length === 0 || live.some((row) => row.isPrimary)) continue;
    await tx
      .update(productExternalId)
      .set({ isPrimary: true })
      .where(eq(productExternalId.id, live[0]!.id));
  }
}

/**
 * True when an incoming external-id write for a (source, kind) slot is
 * identical to the live row already occupying it. Callers use this to skip a
 * pointless soft-delete+insert (or update) that would otherwise mint a
 * tombstone / bump `updatedAt` for data that didn't actually change. A `url`
 * difference alone still counts as a real change — `storedExternalIdUrl`
 * handles the amazon/asin derived-url special case so the comparison matches
 * what would actually be persisted.
 */
export function externalIdSlotUnchanged(
  existing: Pick<
    typeof productExternalId.$inferSelect,
    "source" | "kind" | "externalId" | "url" | "isPrimary"
  >,
  incoming: Pick<
    ExternalIdInput,
    "source" | "kind" | "externalId" | "url" | "isPrimary"
  >,
): boolean {
  return (
    existing.source === incoming.source &&
    existing.kind === incoming.kind &&
    existing.externalId === incoming.externalId &&
    existing.url === storedExternalIdUrl(incoming) &&
    // Promoting or demoting a row IS a change, and skipping it here would
    // silently discard the caller's intent.
    existing.isPrimary === (incoming.isPrimary ?? true)
  );
}

/**
 * Reconcile a product's external IDs against the desired set.
 * Same diff pattern as unit mappings, but removals are soft-deletes (deletedAt)
 * since external IDs are referenced elsewhere and retained for history.
 */
export async function syncProductExternalIds(
  tx: DrizzleTransaction,
  productId: ProductId,
  externalIds: ExternalIdInput[],
): Promise<void> {
  const existingExternalIds = await tx.query.productExternalId.findMany({
    where: and(
      eq(productExternalId.productId, productId),
      notDeleted(productExternalId),
    ),
  });

  const normalized = externalIds.map((eid) => ({
    ...eid,
    source: eid.source.trim().toLowerCase(),
  }));

  // An incoming entry with no `id` is nominally a "create", but when it lands
  // on a slot (source+kind) that already has a live row with the identical
  // externalId/url, it's a re-submission of the current value, not a real
  // change. Leave that row untouched (no tombstone, no updatedAt bump)
  // instead of soft-deleting it and inserting an identical copy.
  const unchangedExistingIds = new Set<string>();
  const toCreate = normalized.filter((eid) => {
    if (eid.id !== undefined) return false;
    // Matched by VALUE within the slot: a slot now holds one primary plus any
    // number of secondaries, so "the row in this slot" is no longer singular.
    const liveSlot = existingExternalIds.find(
      (e) =>
        e.source === eid.source &&
        e.kind === eid.kind &&
        e.externalId === eid.externalId,
    );
    if (liveSlot && externalIdSlotUnchanged(liveSlot, eid)) {
      unchangedExistingIds.add(liveSlot.id);
      return false;
    }
    return true;
  });

  const toDelete = existingExternalIds.filter(
    (e) =>
      !unchangedExistingIds.has(e.id) &&
      !externalIds.some((eid) => eid.id === e.id),
  );
  const toUpdate = externalIds.filter(
    (e): e is ExternalIdInput & { id: string } => e.id !== undefined,
  );

  if (toDelete.length > 0) {
    await tx
      .update(productExternalId)
      .set({ deletedAt: new Date() })
      .where(
        inArray(
          productExternalId.id,
          toDelete.map((e) => e.id),
        ),
      );
  }

  // Updates BEFORE creates. An update may DEMOTE the slot's current primary
  // while a create inserts its replacement, and the partial unique is a plain
  // non-deferrable index — so inserting first throws on a slot that already has
  // a primary, before the demotion that would have made room for it.
  for (const raw of toUpdate) {
    const eid = { ...raw, source: raw.source.trim().toLowerCase() };
    await tx
      .update(productExternalId)
      .set({
        source: eid.source,
        kind: eid.kind,
        externalId: eid.externalId,
        url: storedExternalIdUrl(eid),
        isPrimary: eid.isPrimary ?? true,
      })
      .where(eq(productExternalId.id, eid.id));
  }

  if (toCreate.length > 0) {
    await tx.insert(productExternalId).values(
      toCreate.map((eid) => ({
        productId,
        source: eid.source,
        kind: eid.kind,
        externalId: eid.externalId,
        url: storedExternalIdUrl(eid),
        isPrimary: eid.isPrimary ?? true,
      })),
    );
  }

  await ensureSlotPrimaries(tx, productId, [
    ...normalized,
    ...existingExternalIds,
  ]);
}

/**
 * Add newly-uploaded images, remove requested ones, and apply an explicit
 * display order (first = cover) for a product. Order is applied before the
 * append so new images always land after the reordered existing set.
 *
 * Returns the R2 keys of images the removal reaped (see
 * {@link detachImagesFromEntity}). They have no rollback, so the caller drops
 * the objects only after its transaction commits.
 */
export async function syncProductImages(
  tx: DrizzleTransaction,
  productId: ProductId,
  pendingImageIds: string[] | undefined,
  removeImageIds: string[] | undefined,
  imageOrder?: string[],
): Promise<string[]> {
  let detachedImageKeys: string[] = [];

  if (imageOrder && imageOrder.length > 0) {
    await applyImageOrder(
      tx,
      productImage,
      productImage.productId,
      productId,
      imageOrder,
    );
  }

  if (removeImageIds && removeImageIds.length > 0) {
    ({ deletedKeys: detachedImageKeys } = await detachImagesFromEntity(
      tx,
      "product",
      productId,
      removeImageIds,
    ));
  }

  if (pendingImageIds && pendingImageIds.length > 0) {
    const startSortOrder = await nextImageSortOrder(
      tx,
      productImage,
      productImage.productId,
      productId,
    );
    await associatePendingImages(
      tx,
      productImage,
      "productId",
      productId,
      pendingImageIds,
      startSortOrder,
    );
  }

  return detachedImageKeys;
}
