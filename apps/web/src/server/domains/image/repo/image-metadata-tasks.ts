import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import type { ImageId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import { publishInBackground } from "~/server/workflows/background-tasks/publish";

export const isImageContentType = (contentType: string): boolean =>
  contentType.toLowerCase().startsWith("image/");

const imageMetadataExtractTask = (imageId: ImageId): BackgroundTaskInput => ({
  kind: "image-metadata.extract",
  requestedAt: new Date().toISOString(),
  imageId,
});

/**
 * The wakeup every image-finalize seam publishes: presigned-upload finalize,
 * `createOrReuseAttachedImage` (MCP/native attach), URL import, and the
 * photo-import commit's per-item activation. Fire-and-forget like every other
 * post-mutation publish — `Image.metadataRevision` is the durable stale
 * marker a lost message doesn't threaten (repaired by "Settle now" or the
 * `backfillImageMetadata` maintenance sweep).
 */
export async function publishImageMetadataExtraction(
  db: Database,
  imageId: ImageId,
  contentType: string,
  source: string,
): Promise<void> {
  if (!isImageContentType(contentType)) return;
  await publishInBackground(db, [imageMetadataExtractTask(imageId)], {
    source,
  });
}

/** The same task, for a caller (photo-import commit) that must defer
 * publication until after its own write transaction commits. */
export const buildImageMetadataExtractionTasks = (
  imageIds: readonly ImageId[],
): BackgroundTaskInput[] => imageIds.map((id) => imageMetadataExtractTask(id));
