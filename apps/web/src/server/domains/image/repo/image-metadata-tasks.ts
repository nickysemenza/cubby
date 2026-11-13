import type { ImageId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db/database";

import { getImageMetadataExtractionRow } from "./image";
const isImageContentType = (contentType: string) =>
  contentType.toLowerCase().startsWith("image/");
/** Start the source-revision pass inside the original writer's transaction. */
export async function publishImageMetadataExtraction(
  db: Database,
  imageId: ImageId,
  contentType: string,
  _source: string,
): Promise<void> {
  if (!isImageContentType(contentType)) return;
  const row = await getImageMetadataExtractionRow(db, imageId);
  if (!row) return;
  const { startPass } = await import("~/server/kernel/api");
  await startPass(db, "image.metadata", {
    key: `${imageId}:${row.key}`,
    cursor: { imageId },
  });
}
