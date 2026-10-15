import type { ImageId } from "@cubby/schemas/identifiers";
import type { StoredImageEmbeddedMetadata } from "@cubby/schemas/image";

import { getS3ObjectRange } from "~/server/clients/s3";
import type { Database } from "~/server/db";
import {
  getImageMetadataExtractionRow,
  type ImageMetadataExtractionRow,
} from "~/server/domains/image/repo/image";
import { applyImageMetadataExtraction } from "~/server/domains/image/repo/image-metadata";
import {
  extractImageMetadata,
  type ImageEmbeddedMetadata,
} from "~/server/domains/image/service/image-metadata";

/** A container's leading bytes hold every tag this parser reads; never worth
 * fetching more than a few MiB even for a multi-hundred-megabyte original. */
const MAX_METADATA_FETCH_BYTES = 4 * 1024 * 1024;

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
