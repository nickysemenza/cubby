import { gzipSync } from "node:zlib";

import { foodSummary } from "@cubby/usda";
import {
  manifestKey,
  RELEASE_MANIFEST_FILE,
  releaseManifest,
  releaseShardLine,
  shardKey,
  type ReleaseId,
  type ReleaseManifest,
} from "@cubby/usda/release";

/** One object of a USDA release, keyed exactly as the release object reads R2. */
export interface UsdaReleaseFile {
  key: string;
  body: Uint8Array;
}

const foundationFoods = [
  {
    id: 9900001,
    name: "Synthetic rolled oats",
    nutrients: { "208": 380, "203": 12, "204": 7, "205": 67 },
  },
  {
    id: 9900002,
    name: "Synthetic fresh apple",
    nutrients: { "208": 52, "203": 0.3, "204": 0.2, "205": 14 },
  },
  {
    id: 9900003,
    name: "Synthetic plain yogurt",
    nutrients: { "208": 61, "203": 3.5, "204": 3.3, "205": 4.7 },
  },
];

// Every line is validated, so a schema change fails here rather than as a
// release load failure in dev or a harness run.
const lines = [
  ...foundationFoods.map((fixture) =>
    releaseShardLine.parse({
      food: foodSummary.parse({
        fdc_id: fixture.id,
        foodInfo: { data_type: "foundation_food", description: fixture.name },
        brandedFoodInfo: null,
        legacyFoodInfo: null,
        nutritionInfo: {
          nutrientSummary: [],
          nutrientsPer100: fixture.nutrients,
        },
        portionInfoRaw: [],
      }),
      supersededFdcIds: [],
    }),
  ),
  // A barcode (UPC-A in the restricted-circulation `2` prefix, never a
  // published product) and an older revision exercise barcode and alias reads.
  releaseShardLine.parse({
    food: foodSummary.parse({
      fdc_id: 9900010,
      foodInfo: {
        data_type: "branded_food",
        description: "Synthetic granola bar",
      },
      brandedFoodInfo: {
        brand_owner: "Synthetic Foods Co",
        brand_name: "SYNTHETIC",
        branded_food_category: "Synthetic snacks",
        gtin_upc: "299000000106",
        ingredients: "SYNTHETIC OATS, SYNTHETIC HONEY",
        serving: {
          serving_size: 40,
          serving_size_unit: "g",
          household_serving_fulltext: "1 bar",
        },
      },
      legacyFoodInfo: null,
      nutritionInfo: {
        nutrientSummary: [],
        nutrientsPer100: { "208": 450, "203": 8, "204": 18, "205": 64 },
      },
      portionInfoRaw: [],
    }),
    supersededFdcIds: [9900009],
  }),
];

/** The synthetic release dev and the workerd harness load, as one shard. */
export function syntheticUsdaReleaseFiles(
  release: ReleaseId,
): UsdaReleaseFile[] {
  const foodsByDataType: ReleaseManifest["foodsByDataType"] = {};
  for (const line of lines) {
    const type = line.food.foodInfo.data_type;
    foodsByDataType[type] = (foodsByDataType[type] ?? 0) + 1;
  }
  const manifest = releaseManifest.parse({
    release,
    shardCount: 1,
    foodsByDataType,
    supersededCount: lines.reduce(
      (total, line) => total + line.supersededFdcIds.length,
      0,
    ),
  } satisfies ReleaseManifest);
  const ndjson = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  return [
    { key: shardKey(release, 0), body: gzipSync(ndjson) },
    {
      key: manifestKey(release),
      body: new TextEncoder().encode(JSON.stringify(manifest)),
    },
  ];
}

/**
 * Upload a release, shards before the manifest so a reader never sees a
 * manifest whose shards are missing. An object already stored at the same
 * size is skipped, so restarting dev with a full release does not re-upload it.
 */
export async function seedUsdaRelease(
  bucket: {
    head(key: string): Promise<{ size: number } | null>;
    put(key: string, body: Uint8Array): Promise<{ key: string } | null>;
  },
  files: UsdaReleaseFile[],
): Promise<void> {
  const isManifest = (file: UsdaReleaseFile) =>
    Number(file.key.endsWith(`/${RELEASE_MANIFEST_FILE}`));
  const ordered = [...files].sort((a, b) => isManifest(a) - isManifest(b));
  for (const file of ordered) {
    const existing = await bucket.head(file.key);
    if (existing?.size === file.body.byteLength) continue;
    await bucket.put(file.key, file.body);
  }
}
