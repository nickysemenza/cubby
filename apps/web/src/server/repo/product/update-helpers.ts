import {
  type ExternalIdInput,
  GTIN_KIND,
  GTIN_SOURCE,
  normalizeGtin,
  storedExternalIdUrl,
} from "@cubby/schemas/external-id";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { isCanonicalPriceMapping } from "~/lib/price-mapping-utils";
import { wasm } from "~/lib/wasm";
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
  imageJoinBindings,
  nextImageSortOrder,
  notDeleted,
} from "~/server/repo/database-helpers";
import { detachImagesFromEntity } from "~/server/repo/image";
import {
  resolveAllPresent,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";

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
    existing.isPrimary === (incoming.isPrimary ?? true)
  );
}

/**
 * Canonicalize a barcode on the way into the database.
 *
 * The Zod `gtin` schema already transforms at the browser/MCP boundary, but the
 * repository is called directly too — test fixtures, the UPC orchestration
 * service, importers — and none of those see it. Normalizing again here is what
 * makes the canonical form an invariant of the TABLE rather than of one entry
 * point, and `ProductExternalId_gtin_digits_check` is the backstop that proves
 * it: adding the constraint is how every direct caller was found.
 *
 * Throws rather than dropping the value. Silently discarding a barcode is the
 * worse failure — nothing downstream can tell it happened.
 */
function requireCanonicalGtin(value: string): string {
  const normalized = normalizeGtin(value.trim());
  if (normalized === null) {
    throw createAppError(
      "PRODUCT_GTIN_INVALID",
      `“${value}” is not a barcode — expected 8-14 digits.`,
    );
  }
  return normalized;
}

function requireCanonicalIsbn(value: string): string {
  const normalized =
    wasm.isbn_from_gtin(value.trim()) ?? wasm.normalize_isbn(value);
  if (normalized == null) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `“${value}” is not a valid ISBN-10 or ISBN-13.`,
    );
  }
  return normalized.gtin14;
}

/**
 * Collapse the compatibility barcode input and the explicit ISBN input onto
 * the one primary GTIN slot they both address.
 *
 * `undefined` leaves the slot alone; `null` retires its primary. When both
 * carry values they must name the same printed identity, otherwise accepting
 * one would silently discard the other.
 */
export function resolvePrimaryProductCodeInput(input: {
  upc?: string | null;
  isbn?: string | null;
}): string | null | undefined {
  const gtin =
    input.upc == null ? input.upc : requireCanonicalGtin(input.upc.trim());
  const bookGtin =
    input.isbn == null ? input.isbn : requireCanonicalIsbn(input.isbn);

  if (gtin != null && bookGtin != null && gtin !== bookGtin) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "UPC/barcode and ISBN identify different printed products. Keep only the correct one, or make them agree.",
    );
  }
  if (bookGtin != null) return bookGtin;
  if (gtin != null) return gtin;
  return input.isbn === null || input.upc === null ? null : undefined;
}

export function externalIdsContainIsbn(
  externalIds: ReadonlyArray<{
    source: string;
    externalId: string;
    deletedAt?: Date | null;
  }>,
): boolean {
  return externalIds.some(
    (entry) =>
      entry.deletedAt == null &&
      entry.source.trim().toLowerCase() === GTIN_SOURCE &&
      wasm.isbn_from_gtin(entry.externalId) != null,
  );
}

/**
 * Set (or clear) the barcode that stands for a product, without disturbing its
 * other identifiers.
 *
 * This is what the `upc` write input on create/update lands on.
 * `syncProductExternalIds` below cannot serve it: that REPLACES the whole set,
 * so a caller passing only a barcode would wipe every ASIN and retailer SKU.
 *
 * `null` retires the PRIMARY barcode, not every barcode — a product can hold
 * several, and `ensureSlotPrimaries` then promotes the oldest survivor. That is
 * the same rule `patch_product_external_ids` documents for removing a primary;
 * to clear the whole set, pass an explicit `externalIds` payload.
 */
export async function syncPrimaryGtin(
  tx: DrizzleTransaction,
  productId: ProductId,
  raw: string | null,
): Promise<void> {
  const value = raw === null ? null : requireCanonicalGtin(raw);
  const live = await tx.query.productExternalId.findMany({
    where: and(
      eq(productExternalId.productId, productId),
      eq(productExternalId.source, GTIN_SOURCE),
      notDeleted(productExternalId),
    ),
    orderBy: [asc(productExternalId.createdAt), asc(productExternalId.id)],
  });
  const currentPrimary = live.find((row) => row.isPrimary);

  if (value === null) {
    if (currentPrimary) {
      await tx
        .update(productExternalId)
        .set({ deletedAt: new Date() })
        .where(eq(productExternalId.id, currentPrimary.id));
    }
  } else if (currentPrimary?.externalId !== value) {
    // Demote BEFORE promoting or inserting: the partial unique is a plain
    // non-deferrable index, so two primaries exist momentarily otherwise and
    // the write aborts. Same ordering `syncProductExternalIds` relies on.
    if (currentPrimary) {
      await tx
        .update(productExternalId)
        .set({ isPrimary: false })
        .where(eq(productExternalId.id, currentPrimary.id));
    }
    const existing = live.find((row) => row.externalId === value);
    if (existing) {
      await tx
        .update(productExternalId)
        .set({ isPrimary: true })
        .where(eq(productExternalId.id, existing.id));
    } else {
      await tx.insert(productExternalId).values({
        productId,
        source: GTIN_SOURCE,
        kind: GTIN_KIND,
        externalId: value,
        isPrimary: true,
      });
    }
  }

  await ensureSlotPrimaries(tx, productId, [
    { source: GTIN_SOURCE, kind: GTIN_KIND },
  ]);
}

export function foldGtinIntoExternalIds(
  externalIds: ExternalIdInput[],
  raw: string | null,
): ExternalIdInput[] {
  const value = raw === null ? null : requireCanonicalGtin(raw);
  const others = externalIds.filter(
    (entry) => entry.source !== GTIN_SOURCE || entry.externalId !== value,
  );
  const demoted = others.map((entry) =>
    entry.source === GTIN_SOURCE ? { ...entry, isPrimary: false } : entry,
  );
  return value === null
    ? demoted
    : [...demoted, { source: GTIN_SOURCE, kind: GTIN_KIND, externalId: value }];
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
 * `removeImageIds`/`imageOrder` are public `IMG-` shortcodes — what the web
 * `ProductOut.images[].id` hands back — resolved to uuids here, right before
 * `applyImageOrder`/`detachImagesFromEntity`, which both still take uuids. A
 * code that doesn't resolve is dropped rather than thrown on, matching
 * today's silent no-op for a uuid naming no live row.
 *
 * Returns the R2 keys of images the removal reaped (see
 * {@link detachImagesFromEntity}). They have no rollback, so the caller drops
 * the objects only after its transaction commits.
 */
export async function syncProductImages(
  tx: DrizzleTransaction,
  productId: ProductId,
  pendingImageIds: string[] | undefined,
  pendingImagePurposes: Record<string, "item" | "label"> | undefined,
  removeImageIds: string[] | undefined,
  imageOrder?: string[],
): Promise<string[]> {
  let detachedImageKeys: string[] = [];

  if (imageOrder && imageOrder.length > 0) {
    const orderedIds = await resolveAllPresent(tx, "image", imageOrder);
    await applyImageOrder(tx, imageJoinBindings.product, productId, orderedIds);
  }

  if (removeImageIds && removeImageIds.length > 0) {
    const idsToRemove = await resolveAllPresent(tx, "image", removeImageIds);
    ({ deletedKeys: detachedImageKeys } = await detachImagesFromEntity(
      tx,
      { entity: "product", id: productId },
      idsToRemove,
    ));
  }

  if (pendingImageIds && pendingImageIds.length > 0) {
    const resolvedPendingImageIds = await resolveAllPresent(
      tx,
      "image",
      pendingImageIds,
    );
    const startSortOrder = await nextImageSortOrder(
      tx,
      imageJoinBindings.product,
      productId,
    );
    // Generic association creates a new live join. Preserve the most recent
    // detached role unless the caller explicitly corrects it.
    const detachedRoles = await tx
      .select({ imageId: productImage.imageId, purpose: productImage.purpose })
      .from(productImage)
      .where(
        and(
          eq(productImage.productId, productId),
          inArray(productImage.imageId, resolvedPendingImageIds),
          isNotNull(productImage.deletedAt),
          isNotNull(productImage.purpose),
        ),
      )
      .orderBy(asc(productImage.updatedAt), asc(productImage.id));
    const detachedPurposeByImageId = new Map(
      detachedRoles.map((row) => [row.imageId, row.purpose]),
    );
    await associatePendingImages(
      tx,
      imageJoinBindings.product,
      productId,
      resolvedPendingImageIds,
      startSortOrder,
    );
    const resolvedByCode = await resolveLiveShortcodes(
      tx,
      pendingImageIds,
      "image",
    );
    for (const [shortcode, imageId] of resolvedByCode) {
      const requestedPurpose = pendingImagePurposes?.[shortcode];
      const purpose = requestedPurpose ?? detachedPurposeByImageId.get(imageId);
      if (!purpose) continue;
      await tx
        .update(productImage)
        .set({ purpose })
        .where(
          and(
            eq(productImage.productId, productId),
            eq(productImage.imageId, imageId),
            notDeleted(productImage),
            // An explicit caller purpose is a correction; a restored role only
            // fills the null role generated by generic reattachment.
            requestedPurpose ? undefined : isNull(productImage.purpose),
          ),
        );
    }
  }

  return detachedImageKeys;
}
