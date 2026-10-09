import { gzipSync } from "node:zlib";
import type { R2Bucket } from "@cloudflare/workers-types";

import { foodSummary } from "@cubby/usda";
import {
  manifestKey,
  releaseManifest,
  releaseShardLine,
  shardKey,
  type ReleaseId,
  type ReleaseManifest,
} from "@cubby/usda/release";

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
function syntheticUsdaReleaseFiles(release: ReleaseId) {
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
 * Upload the synthetic release. The release object reads R2 only on its
 * first read, so seeding must precede any USDA request.
 */
export async function seedUsdaRelease(
  bucket: Pick<R2Bucket, "put">,
  release: ReleaseId,
): Promise<void> {
  for (const file of syntheticUsdaReleaseFiles(release))
    await bucket.put(file.key, file.body);
}
