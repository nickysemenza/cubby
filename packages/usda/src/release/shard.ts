import { z } from "zod";
import { dataTypeEnum, fdcId, foodSummary } from "../schemas";

// The R2 layout of one USDA release. Shards hold plain `FoodSummary` records, so
// they outlive any change to the release Durable Object's table layout: a new
// schema generation reloads the same shards (ADR 0008).
export const RELEASE_MANIFEST_FILE = "manifest.json";

export const releaseId = z
  .string()
  .regex(/^\d{4}-\d{2}$/u, "USDA release id is YYYY-MM");
export type ReleaseId = z.infer<typeof releaseId>;

export const shardKey = (release: ReleaseId, index: number) =>
  `${release}/shard-${String(index).padStart(5, "0")}.ndjson.gz`;

export const manifestKey = (release: ReleaseId) =>
  `${release}/${RELEASE_MANIFEST_FILE}`;

// The key that groups a branded food's revisions and answers a barcode lookup:
// the published digits zero-padded to GTIN-14. No check-digit rule — FDC's
// `gtin_upc` values are ingested as published (`barcodeDigits`), and a 12-digit
// UPC-A, its 13-digit reprint, and a leading-zero-stripped copy must collide.
export const usdaBarcodeKey = (digits: string): string | null => {
  const trimmed = digits.trim();
  return /^\d{1,14}$/u.test(trimmed) ? trimmed.padStart(14, "0") : null;
};

// One gzipped NDJSON line. `food` is always the current food revision;
// `supersededFdcIds` are the older revisions of the same barcoded food, which
// resolve to it.
export const releaseShardLine = z.object({
  food: foodSummary,
  supersededFdcIds: z.array(fdcId),
});
export type ReleaseShardLine = z.infer<typeof releaseShardLine>;

export const releaseManifest = z.object({
  release: releaseId,
  shardCount: z.number().int().positive(),
  foodsByDataType: z.partialRecord(dataTypeEnum, z.number().int().min(0)),
  supersededCount: z.number().int().min(0),
});
export type ReleaseManifest = z.infer<typeof releaseManifest>;
