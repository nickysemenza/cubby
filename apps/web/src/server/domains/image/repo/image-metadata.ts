import type { ImageId } from "@cubby/schemas/identifiers";
import type { StoredImageEmbeddedMetadata } from "@cubby/schemas/image";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, withTransaction } from "~/server/db/helpers";
import { image } from "~/server/db/schema";
import {
  setImageEmbeddedMetadata,
  type ImageMetadataExtractionRow,
} from "~/server/domains/image/repo/image";
import { deriveAndStoreImageCapture } from "~/server/domains/image/repo/image-capture-derivation";
import type { Fenced } from "~/server/generic/jobs/types";

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

/** Publish extracted metadata only while this Job and the original bytes remain current. */
export async function publishExtractedImageMetadata(
  fenced: Fenced,
  imageId: ImageId,
  source: ImageMetadataExtractionRow,
  read: (
    tx: Database,
    id: ImageId,
  ) => Promise<ImageMetadataExtractionRow | undefined>,
  write: (tx: Database) => Promise<void>,
) {
  await fenced(async (tx) => {
    await getDb(tx)
      .select({ id: image.id })
      .from(image)
      .where(eq(image.id, imageId))
      .for("update");
    const current = await read(tx, imageId);
    if (
      !current ||
      current.key !== source.key ||
      current.contentType !== source.contentType
    )
      throw new Error("Image metadata source changed during extraction");
    await write(tx);
  });
}
