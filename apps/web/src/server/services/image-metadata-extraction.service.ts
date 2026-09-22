import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import type { ImageId } from "@cubby/schemas/identifiers";
import type { StoredImageEmbeddedMetadata } from "@cubby/schemas/image";

import { publishInBackground } from "~/server/background-tasks/publish";
import type { Database } from "~/server/db";
import {
  getImageMetadataExtractionRow,
  type ImageMetadataExtractionRow,
} from "~/server/repo/image";
import { applyImageMetadataExtraction } from "~/server/repo/image-metadata";
import {
  extractImageMetadata,
  type ImageEmbeddedMetadata,
} from "~/server/services/image-metadata";
import { getS3ObjectRange } from "~/server/utils/s3";

/** A container's leading bytes hold every tag this parser reads; never worth
 * fetching more than a few MiB even for a multi-hundred-megabyte original. */
const MAX_METADATA_FETCH_BYTES = 4 * 1024 * 1024;

export const isImageContentType = (contentType: string): boolean =>
  contentType.toLowerCase().startsWith("image/");

/** `null` on a 404 (object missing — leave the stale marker as-is for a
 * later retry rather than mask a lost object as "no metadata"); throws on any
 * other failed fetch, same as `image-verification.service.ts`'s port. */
const fetchLeadingBytes = async (
  key: string,
  maxBytes: number,
): Promise<Uint8Array | null> => {
  const response = await getS3ObjectRange(key, maxBytes);
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`Failed to read ${key}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

const toStoredMetadata = (
  parsed: ImageEmbeddedMetadata | null,
): StoredImageEmbeddedMetadata | null =>
  parsed && {
    capturedAt: parsed.capturedAt ? parsed.capturedAt.toISOString() : null,
    capturedAtOffsetMinutes: parsed.capturedAtOffsetMinutes,
    location: parsed.location,
    camera: parsed.camera,
    orientation: parsed.orientation,
  };

export interface ExtractImageMetadataPorts {
  readonly getRow: (
    db: Database,
    imageId: ImageId,
  ) => Promise<ImageMetadataExtractionRow | undefined>;
  readonly getBytes: typeof fetchLeadingBytes;
  readonly extract: typeof extractImageMetadata;
  readonly apply: typeof applyImageMetadataExtraction;
}

const productionExtractImageMetadataPorts: ExtractImageMetadataPorts = {
  getRow: getImageMetadataExtractionRow,
  getBytes: fetchLeadingBytes,
  extract: extractImageMetadata,
  apply: applyImageMetadataExtraction,
};

/**
 * Extracts and stores one image's embedded EXIF/GPS metadata, then re-derives
 * its capture fields. Idempotent by construction: `getRow`'s own WHERE only
 * matches an UPLOADED `image/*` row whose `metadataRevision` is still stale,
 * so a duplicate or out-of-order queue delivery after the row already
 * advanced reads no row and reports `"skipped"`.
 */
export async function extractAndStoreImageMetadata(
  db: Database,
  imageId: ImageId,
  ports: ExtractImageMetadataPorts = productionExtractImageMetadataPorts,
): Promise<"succeeded" | "skipped"> {
  const row = await ports.getRow(db, imageId);
  if (!row) return "skipped";
  const bytes = await ports.getBytes(row.key, MAX_METADATA_FETCH_BYTES);
  // The object is missing — a storage-integrity problem for a different
  // repair path to find; leaving the stale marker means this row is retried
  // rather than silently recorded as "no metadata found".
  if (bytes === null) return "skipped";
  const parsed = ports.extract(bytes, row.contentType);
  await ports.apply(db, imageId, toStoredMetadata(parsed));
  return "succeeded";
}

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
