import type { ImageId } from "@cubby/schemas/identifiers";
import type { StoredImageEmbeddedMetadata } from "@cubby/schemas/image";

import type { Database } from "~/server/db";
import { withTransaction } from "~/server/repo/database-helpers";
import { setImageEmbeddedMetadata } from "~/server/repo/image";
import { deriveAndStoreImageCapture } from "~/server/services/image-capture-derivation";

/**
 * Writes extracted EXIF and re-derives the image's capture fields in one
 * transaction, mirroring every other writer of `Image.embeddedMetadata`-
 * adjacent state (`image-sighting.ts`'s upsert/update/delete all call
 * `deriveAndStoreImageCapture` inside their own transaction). Kept in its own
 * file rather than `repo/image.ts` itself: `image-capture-derivation.ts`
 * already imports read/write helpers FROM `repo/image.ts`, so importing the
 * derivation service back into `repo/image.ts` would create a cycle.
 */
export async function applyImageMetadataExtraction(
  db: Database,
  imageId: ImageId,
  embeddedMetadata: StoredImageEmbeddedMetadata | null,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await setImageEmbeddedMetadata(tx, imageId, embeddedMetadata);
    await deriveAndStoreImageCapture(tx, imageId);
  });
}
