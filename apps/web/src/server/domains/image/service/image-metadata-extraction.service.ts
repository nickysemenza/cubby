import type { ImageId } from "@cubby/schemas/identifiers";
import type { StoredImageEmbeddedMetadata } from "@cubby/schemas/image";

import { getS3ObjectRange } from "~/server/clients/s3";
import type { Database } from "~/server/db";
import {
  getImageMetadataExtractionRow,
  markImageMetadataOutcome,
  type ImageMetadataExtractionRow,
} from "~/server/domains/image/repo/image";
import {
  publishExtractedImageMetadata,
  applyImageMetadataExtraction,
} from "~/server/domains/image/repo/image-metadata";
import {
  extractImageMetadata,
  type ImageEmbeddedMetadata,
} from "~/server/domains/image/service/image-metadata";
import { publishTransaction } from "~/server/kernel/publication";
import type { Publication } from "~/server/kernel/publication";

/** A container's leading bytes hold every tag this parser reads; never worth
 * fetching more than a few MiB even for a multi-hundred-megabyte original. */
const MAX_METADATA_FETCH_BYTES = 4 * 1024 * 1024;

/** `null` on a 404 (object missing — recorded as `original_missing` rather
 * than masked as "no metadata"); throws on any other failed fetch, same as
 * `image-verification.service.ts`'s port. */
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
  /** The executing Job's fence; member and maintenance callers own no Job. */
  fenced: Publication = publishTransaction(db),
): Promise<"succeeded" | "skipped" | { missing: string }> {
  const row = await ports.getRow(db, imageId);
  if (!row) return "skipped";
  const { withAsk, append, evidenceRow } = await import("~/server/kernel/api");
  const { imageMetadataAsk, imageObservationEvidence } =
    await import("~/server/domains/image-processing/module");
  const input = {
    imageId,
    key: row.key,
    contentType: row.contentType,
    sourceRevision: row.sourceRevision,
  };
  const result = await withAsk(
    db,
    {
      ...imageMetadataAsk,
      produce: async () => ({
        output: await produceImageMetadata(input, ports),
      }),
    },
    input,
    {
      record: { entity: "image", id: imageId },
      pass: { name: "image.metadata", key: `${imageId}:${row.key}` },
    },
  );
  const { askEnvelope, inputHashOf } = await import("~/server/kernel/envelope");
  const inputHash = await inputHashOf(askEnvelope(imageMetadataAsk, input));
  const publish = (write: (tx: Database) => Promise<void>) =>
    publishExtractedImageMetadata(
      fenced,
      imageId,
      row,
      ports.getRow,
      async (tx) => {
        await append(tx, [
          evidenceRow(imageObservationEvidence, {
            entityKind: "image",
            entityId: imageId,
            inputHash,
            kind: "embedded-metadata",
            value: result,
          }),
        ]);
        await write(tx);
      },
    );
  if (result.missing) {
    const missing = `R2 object not found: ${row.key} (404)`;
    await publish(async (tx) => {
      await markImageMetadataOutcome(tx, imageId, "original_missing", missing);
    });
    return { missing };
  }
  await publish((tx) => ports.apply(tx, imageId, result.metadata));
  return "succeeded";
}

/** The producer sees only the declared immutable original identity. */
export async function produceImageMetadata(
  input: { key: string; contentType: string },
  ports: Pick<
    ExtractImageMetadataPorts,
    "getBytes" | "extract"
  > = productionExtractImageMetadataPorts,
): Promise<{ missing: boolean; metadata: StoredImageEmbeddedMetadata | null }> {
  // Keep bounded storage retries inside one Ask; repeated admission observes its backoff.
  for (let attempt = 1; ; attempt++) {
    try {
      const bytes = await ports.getBytes(input.key, MAX_METADATA_FETCH_BYTES);
      return bytes === null
        ? { missing: true, metadata: null }
        : {
            missing: false,
            metadata: toStoredMetadata(ports.extract(bytes, input.contentType)),
          };
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}
