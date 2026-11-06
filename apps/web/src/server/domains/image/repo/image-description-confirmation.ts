import type { ImageId } from "@cubby/schemas/identifiers";
import { imageDescriptionConfirmationOwner } from "@cubby/schemas/image-processing";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { image } from "~/server/db/schema";
import { recordChange } from "~/server/generic/changes/repo/change";

/** The Image lock fences confirmation against content replacement; inference never writes these columns. */
export async function confirmImageDescription(
  db: Database,
  input: {
    imageId: ImageId;
    contentHash: string;
    description: string;
    operationId: string;
  },
  actorUserId: string,
) {
  return withTransactionDatabase(db, async (tx) => {
    const [source] = await getDb(tx)
      .select()
      .from(image)
      .where(and(eq(image.id, input.imageId), notDeleted(image)))
      .for("update");
    if (!source || source.sha256 !== input.contentHash)
      throw new Error("Image evidence changed before confirmation");
    const owner = imageDescriptionConfirmationOwner.parse({
      kind: "member",
      effectId: input.operationId,
      actorUserId,
    });
    const confirmedAt = new Date();
    await getDb(tx)
      .update(image)
      .set({
        confirmedDescription: input.description,
        descriptionContentHash: input.contentHash,
        descriptionConfirmedAt: confirmedAt,
        descriptionConfirmationOwner: owner,
      })
      .where(eq(image.id, input.imageId));
    await recordChange(tx, { kind: "source", categories: ["image"] });
    return {
      description: input.description,
      confirmedAt: confirmedAt.toISOString(),
      owner,
    };
  });
}
