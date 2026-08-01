/**
 * Product update helper functions.
 * Private helpers used by updateProduct in crud.ts to reconcile child collections
 * (unit mappings, external IDs, images) against an incoming desired state.
 */

import type { ExternalIdInput } from "@cubby/schemas/external-id";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import { and, eq, inArray } from "drizzle-orm";
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
 * matching ones are updated. Mappings are measurement-only (price is a separate
 * column), so this no longer touches price or inventory valuations.
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

  const toDelete = existingExternalIds.filter(
    (e) => !externalIds.some((eid) => eid.id === e.id),
  );
  const normalized = externalIds.map((eid) => ({
    ...eid,
    source: eid.source.trim().toLowerCase(),
  }));
  const toCreate = normalized.filter((e) => e.id === undefined);
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

  if (toCreate.length > 0) {
    await tx.insert(productExternalId).values(
      toCreate.map((eid) => ({
        productId,
        source: eid.source,
        kind: eid.kind,
        externalId: eid.externalId,
        url: eid.url ?? null,
      })),
    );
  }

  for (const raw of toUpdate) {
    const eid = { ...raw, source: raw.source.trim().toLowerCase() };
    await tx
      .update(productExternalId)
      .set({
        source: eid.source,
        kind: eid.kind,
        externalId: eid.externalId,
        url: eid.url ?? null,
      })
      .where(eq(productExternalId.id, eid.id));
  }
}

/**
 * Add newly-uploaded images, remove requested ones, and apply an explicit
 * display order (first = cover) for a product. Order is applied before the
 * append so new images always land after the reordered existing set.
 */
export async function syncProductImages(
  tx: DrizzleTransaction,
  productId: ProductId,
  pendingImageIds: string[] | undefined,
  removeImageIds: string[] | undefined,
  imageOrder?: string[],
): Promise<void> {
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
    await tx
      .delete(productImage)
      .where(
        and(
          eq(productImage.productId, productId),
          inArray(productImage.imageId, removeImageIds),
        ),
      );
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
}
