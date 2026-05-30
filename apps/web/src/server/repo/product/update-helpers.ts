/**
 * Product update helper functions.
 * Private helpers used by updateProduct in crud.ts to reconcile child collections
 * (unit mappings, external IDs, images) against an incoming desired state.
 */

import type { ExternalIdInput } from "@cubby/schemas/external-id";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleTransaction } from "~/server/db";
import {
  productExternalId,
  productImage,
  productUnitMappings,
} from "~/server/db/schema";
import { associatePendingImages } from "~/server/repo/database-helpers";

import { syncProductPrice } from "./pricing";

/**
 * Reconcile a product's unit mappings against the desired set, then resync price.
 * Mappings with no `id` are created, existing-but-absent ones are hard-deleted, and
 * matching ones are updated. Always calls syncProductPrice so the denormalized price
 * column (and dependent inventory valuations) stays consistent.
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

  // Resync the denormalized price after any unit mapping change.
  await syncProductPrice(tx, productId);
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
      isNull(productExternalId.deletedAt),
    ),
  });

  const toDelete = existingExternalIds.filter(
    (e) => !externalIds.some((eid) => eid.id === e.id),
  );
  const toCreate = externalIds.filter((e) => e.id === undefined);
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
        externalId: eid.externalId,
        url: eid.url ?? null,
      })),
    );
  }

  for (const eid of toUpdate) {
    await tx
      .update(productExternalId)
      .set({
        source: eid.source,
        externalId: eid.externalId,
        url: eid.url ?? null,
      })
      .where(eq(productExternalId.id, eid.id));
  }
}

/**
 * Add newly-uploaded images and remove requested ones for a product.
 */
export async function syncProductImages(
  tx: DrizzleTransaction,
  productId: ProductId,
  pendingImageIds: string[] | undefined,
  removeImageIds: string[] | undefined,
): Promise<void> {
  if (pendingImageIds && pendingImageIds.length > 0) {
    await associatePendingImages(
      tx,
      productImage,
      "productId",
      productId,
      pendingImageIds,
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
}
