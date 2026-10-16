import type { ImageId } from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray } from "drizzle-orm";

import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { photoRunImage } from "~/server/db/retained-tables";

type Membership = typeof photoRunImage.$inferSelect;
const settled = (row: Membership) =>
  row.state === "completed" || row.state === "skipped";
const sameReceipt = (a: Membership, b: Membership) =>
  a.state === b.state &&
  a.outcome === b.outcome &&
  a.skipReason === b.skipReason &&
  a.commitReceipt?.groupKey === b.commitReceipt?.groupKey &&
  a.commitReceipt?.productId === b.commitReceipt?.productId &&
  a.commitReceipt?.purpose === b.commitReceipt?.purpose &&
  a.commitReceipt?.inventoryId === b.commitReceipt?.inventoryId;

/** Collisions retain settled replay data; conflicting commits require a decision. */
export const mergePhotoRunImages = async (
  tx: DrizzleTransaction,
  keepId: ImageId,
  loserIds: readonly ImageId[],
): Promise<void> => {
  if (!loserIds.length) return;
  const memberships = await tx
    .select()
    .from(photoRunImage)
    .where(inArray(photoRunImage.imageId, [keepId, ...loserIds]))
    .orderBy(asc(photoRunImage.id))
    .for("update");
  for (const target of memberships.filter((row) => row.imageId !== keepId)) {
    const [existing] = await tx
      .select()
      .from(photoRunImage)
      .where(
        and(
          eq(photoRunImage.runId, target.runId),
          eq(photoRunImage.imageId, keepId),
          eq(photoRunImage.workKey, target.workKey),
        ),
      );
    if (!existing) {
      await tx
        .update(photoRunImage)
        .set({ imageId: keepId, updatedAt: new Date() })
        .where(eq(photoRunImage.id, target.id));
      continue;
    }
    if (settled(existing) && settled(target) && !sameReceipt(existing, target))
      throw new Error("Image merge has conflicting settled photo receipts");
    if (settled(target) && !settled(existing)) {
      const { id: _id, imageId: _imageId, ...receiptState } = target;
      await tx
        .update(photoRunImage)
        .set({
          ...receiptState,
          position: existing.position ?? target.position,
          createdAt:
            existing.createdAt < target.createdAt
              ? existing.createdAt
              : target.createdAt,
          updatedAt: new Date(),
        })
        .where(eq(photoRunImage.id, existing.id));
    }
    await tx.delete(photoRunImage).where(eq(photoRunImage.id, target.id));
  }
};
