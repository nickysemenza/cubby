import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  manifestKey,
  releaseManifest,
  releaseShardLine,
  shardKey,
  type ReleaseShardLine,
} from "../shard";
import { buildRelease } from "./build-release";

// Synthetic FDC-shaped fixtures. Real failure modes this guards:
// - current revision chosen by fdc_id or by string-compared dates instead of the
//   latest publication_date (food.csv mixes ISO and M/D/YYYY dates);
// - equal publication dates not tie-broken by the highest fdc_id;
// - barcode variants differing only in leading zeros not grouped;
// - empty / non-digit barcodes grouped together under one null key;
// - superseded revisions still emitted as their own lines or their nutrients
//   leaking into another food;
// - nutrients attached to the wrong food when food_nutrient.csv is not sorted;
// - empty-amount nutrients, unknown nutrient ids, empty-gram portions, or
//   portions with no fdc_id reaching the output;
// - the USDA `market_acquistion` typo surviving into the release;
// - quoted commas, quotes and newlines in ingredients breaking CSV parsing;
// - short UPCs left unpadded so `barcodeDigits` rejects the line;
// - manifest counting input rows instead of emitted foods, or omitting
//   zero-count data types;
// - a rebuild leaving stale shards from a larger previous build;
// - an invalid line written silently instead of failing with its fdc_id.

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const csv = (header: readonly string[], rows: readonly (readonly string[])[]) =>
  [header, ...rows].map((row) => row.map(quote).join(",")).join("\n") + "\n";

const BRANDED_HEADER = [
  "fdc_id",
  "brand_owner",
  "brand_name",
  "subbrand_name",
  "gtin_upc",
  "ingredients",
  "not_a_significant_source_of",
  "serving_size",
  "serving_size_unit",
  "household_serving_fulltext",
  "branded_food_category",
  "data_source",
  "package_weight",
  "modified_date",
  "available_date",
  "market_country",
  "discontinued_date",
  "preparation_state_code",
  "trade_channel",
  "short_description",
  "material_code",
] as const;

type BrandedColumn = (typeof BRANDED_HEADER)[number];
const brandedRow = (fields: Partial<Record<BrandedColumn, string>>) =>
  BRANDED_HEADER.map((column) => fields[column] ?? "");

const branded = (
  fdcId: string,
  gtin: string,
  overrides: Partial<Record<BrandedColumn, string>> = {},
) =>
  brandedRow({
    fdc_id: fdcId,
    brand_owner: "Synthetic Foods Co",
    gtin_upc: gtin,
    data_source: "LI",
    market_country: "United States",
    ...overrides,
  });

const FIXTURE = {
  "nutrient.csv": csv(
    ["id", "name", "unit_name", "nutrient_nbr", "rank"],
    [
      ["1003", "Protein", "G", "203", "600.0"],
      ["1008", "Energy", "KCAL", "208", "300.0"],
      ["1093", "Sodium, Na", "MG", "307", "5800.0"],
      ["2000", "Sugars, total", "G", "269", "1510.0"],
    ],
  ),
  "food.csv": csv(
    [
      "fdc_id",
      "data_type",
      "description",
      "food_category_id",
      "publication_date",
    ],
    [
      // Unsorted on purpose; USDA does not sort food.csv.
      ["201", "branded_food", "SYNTH CRACKERS", "", "2023-06-15"],
      ["100", "sr_legacy_food", "Synthetic grain, raw", "20", "2019-04-01"],
      ["101", "market_acquistion", "Synthetic bean sample", "16", "2019-04-01"],
      ["200", "branded_food", "SYNTH CRACKERS", "", "2021-01-01"],
      // Newer fdc_id, older date, and a string compare would rank it latest.
      ["202", "branded_food", "SYNTH CRACKERS", "", "6/1/2022"],
      ["300", "branded_food", "SYNTH SODA", "", "2024-02-02"],
      ["301", "branded_food", "SYNTH SODA", "", "2024-02-02"],
      ["400", "branded_food", "SYNTH BAR", "", "2024-01-01"],
      ["401", "branded_food", "SYNTH BAR", "", "2024-05-01"],
      ["402", "branded_food", "SYNTH CHEW", "", "2024-05-01"],
      ["403", "branded_food", "SYNTH CHEW", "", "2024-06-01"],
      ["500", "foundation_food", "Synthetic leaf, raw", "11", "2020-01-01"],
      ["501", "foundation_food", "Synthetic leaf, raw", "11", "2022-01-01"],
      ["600", "survey_fndds_food", "Synthetic stew", "", "2021-10-28"],
      ["700", "branded_food", "SYNTH MINT", "", "2022-03-03"],
      ["800", "branded_food", "", "", "2022-03-03"],
    ],
  ),
  "branded_food.csv": csv(BRANDED_HEADER, [
    branded("200", "12345678905", { brand_name: "OLD NAME" }),
    branded("201", "012345678905", {
      brand_name: "SYNTH",
      ingredients: 'WHEAT FLOUR, SALT, "SYNTH" OIL\nAND MORE',
      serving_size: "30.0",
      serving_size_unit: "g",
      household_serving_fulltext: "5 crackers",
      branded_food_category: "Crackers & Biscotti",
    }),
    branded("202", "00012345678905"),
    branded("300", "4000000000017"),
    branded("301", "04000000000017"),
    branded("400", ""),
    branded("401", ""),
    branded("402", "0-1234-5"),
    branded("403", "0-1234-5"),
    branded("700", "7000017"),
    branded("800", "50000000000001"),
    // No food.csv row: ignored.
    branded("999", "50000000000001"),
  ]),
  "sr_legacy_food.csv": csv(["fdc_id", "NDB_number"], [["100", "20123"]]),
  "food_nutrient.csv": csv(
    [
      "id",
      "fdc_id",
      "nutrient_id",
      "amount",
      "data_points",
      "derivation_id",
      "min",
      "max",
      "median",
      "loq",
      "footnote",
      "min_year_acquired",
      "percent_daily_value",
    ],
    [
      ["50", "201", "1008", "420.0", "", "", "", "", "", "", "", "", ""],
      ["51", "201", "1003", "9.5", "", "", "", "", "", "", "", "", ""],
      ["12", "100", "2000", "1.2", "", "", "", "", "", "", "", "", ""],
      ["10", "100", "1003", "13.5", "", "", "", "", "", "", "", "", ""],
      ["11", "100", "1008", "350", "", "", "", "", "", "", "", "", ""],
      ["13", "100", "1093", "", "", "", "", "", "", "", "", "", ""],
      ["14", "100", "9999", "5", "", "", "", "", "", "", "", "", ""],
      ["60", "200", "1003", "77.7", "", "", "", "", "", "", "", "", ""],
    ],
  ),
  "food_portion.csv": csv(
    [
      "id",
      "fdc_id",
      "seq_num",
      "amount",
      "measure_unit_id",
      "portion_description",
      "modifier",
      "gram_weight",
      "data_points",
      "footnote",
      "min_year_acquired",
    ],
    [
      ["2", "100", "2", "1.0", "1000", "", "cup", "120.0", "", "", ""],
      ["1", "100", "1", "0.5", "9999", "", "", "60.0", "", "", ""],
      ["3", "100", "3", "1.0", "9999", "", "slice", "", "", "", ""],
      ["4", "", "", "1.0", "9999", "", "orphan", "10.0", "", "", ""],
      ["5", "600", "1", "1.0", "1000", "1 cup", "", "245.0", "", "", ""],
    ],
  ),
};

let root: string;
let csvDir: string;
let outDir: string;

const writeFixture = (files: Record<string, string>) => {
  fs.mkdirSync(csvDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(csvDir, name), content);
  }
};

const readShards = (release: "2026-04", shardCount: number) => {
  const lines: ReleaseShardLine[] = [];
  for (let index = 0; index < shardCount; index++) {
    const text = zlib
      .gunzipSync(fs.readFileSync(path.join(outDir, shardKey(release, index))))
      .toString("utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      lines.push(releaseShardLine.parse(JSON.parse(line)));
    }
  }
  return lines;
};

const byFdcId = (lines: readonly ReleaseShardLine[], fdcId: number) => {
  const line = lines.find((candidate) => candidate.food.fdc_id === fdcId);
  if (!line) throw new Error(`fdc_id ${fdcId} not emitted`);
  return line;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "usda-release-build-"));
  csvDir = path.join(root, "csv");
  outDir = path.join(root, "out");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("buildRelease", () => {
  it("emits one current food per barcode and every other food as-is", async () => {
    writeFixture(FIXTURE);
    const result = await buildRelease({
      csvDir,
      release: "2026-04",
      outDir,
      foodsPerShard: 5,
    });

    const manifest = releaseManifest.parse(
      JSON.parse(
        fs.readFileSync(path.join(outDir, manifestKey("2026-04")), "utf8"),
      ),
    );
    expect(manifest).toEqual(result.manifest);
    expect(manifest).toEqual({
      release: "2026-04",
      shardCount: 3,
      foodsByDataType: {
        agricultural_acquisition: 0,
        branded_food: 8,
        experimental_food: 0,
        foundation_food: 2,
        market_acquisition: 1,
        sample_food: 0,
        sr_legacy_food: 1,
        sub_sample_food: 0,
        survey_fndds_food: 1,
      },
      supersededCount: 3,
    });

    const lines = readShards("2026-04", manifest.shardCount);
    expect(lines.map((line) => line.food.fdc_id)).toEqual([
      100, 101, 201, 301, 400, 401, 402, 403, 500, 501, 600, 700, 800,
    ]);

    // Latest publication_date wins over a newer fdc_id with an M/D/YYYY date.
    const crackers = byFdcId(lines, 201);
    expect(crackers.supersededFdcIds).toEqual([200, 202]);
    expect(crackers.food).toEqual({
      fdc_id: 201,
      foodInfo: { data_type: "branded_food", description: "SYNTH CRACKERS" },
      brandedFoodInfo: {
        brand_owner: "Synthetic Foods Co",
        brand_name: "SYNTH",
        branded_food_category: "Crackers & Biscotti",
        gtin_upc: "012345678905",
        ingredients: 'WHEAT FLOUR, SALT, "SYNTH" OIL\nAND MORE',
        serving: {
          serving_size: 30,
          serving_size_unit: "g",
          household_serving_fulltext: "5 crackers",
        },
      },
      legacyFoodInfo: null,
      nutritionInfo: {
        nutrientSummary: [
          { amount: 420, name: "Energy", unit: "KCAL" },
          { amount: 9.5, name: "Protein", unit: "G" },
        ],
        nutrientsPer100: { "208": 420, "203": 9.5 },
      },
      portionInfoRaw: [],
    });

    // Same date: highest fdc_id wins.
    expect(byFdcId(lines, 301).supersededFdcIds).toEqual([300]);

    // Empty and non-digit barcodes are never grouped.
    for (const fdcId of [400, 401, 402, 403]) {
      const line = byFdcId(lines, fdcId);
      expect(line.supersededFdcIds).toEqual([]);
      expect(line.food.brandedFoodInfo).toBeNull();
    }

    // Short published UPCs are padded to UPC-A.
    expect(byFdcId(lines, 700).food.brandedFoodInfo?.gtin_upc).toBe(
      "000007000017",
    );
    expect(byFdcId(lines, 800).food.foodInfo.description).toBe("<empty>");
    expect(byFdcId(lines, 800).supersededFdcIds).toEqual([]);

    expect(byFdcId(lines, 100).food).toEqual({
      fdc_id: 100,
      foodInfo: {
        data_type: "sr_legacy_food",
        description: "Synthetic grain, raw",
      },
      brandedFoodInfo: null,
      legacyFoodInfo: { ndb_number: 20123 },
      nutritionInfo: {
        nutrientSummary: [
          { amount: 13.5, name: "Protein", unit: "G" },
          { amount: 350, name: "Energy", unit: "KCAL" },
          { amount: 1.2, name: "Sugars, total", unit: "G" },
        ],
        nutrientsPer100: { "203": 13.5, "208": 350 },
      },
      portionInfoRaw: [
        { amount: 0.5, modifier: null, gram_weight: 60 },
        { amount: 1, modifier: "cup", gram_weight: 120 },
      ],
    });

    expect(byFdcId(lines, 101).food.foodInfo.data_type).toBe(
      "market_acquisition",
    );
    expect(byFdcId(lines, 600).food.portionInfoRaw).toEqual([
      { amount: 1, modifier: null, gram_weight: 245 },
    ]);
    // Non-branded foods are never grouped, even with identical descriptions.
    expect(byFdcId(lines, 500).supersededFdcIds).toEqual([]);
    expect(byFdcId(lines, 501).supersededFdcIds).toEqual([]);

    expect(result.lineCount).toBe(lines.length);
  });

  it("replaces a previous build of the same release", async () => {
    writeFixture(FIXTURE);
    await buildRelease({
      csvDir,
      release: "2026-04",
      outDir,
      foodsPerShard: 2,
    });
    const { manifest } = await buildRelease({
      csvDir,
      release: "2026-04",
      outDir,
      foodsPerShard: 5,
    });
    expect(fs.readdirSync(path.join(outDir, "2026-04")).sort()).toEqual([
      "manifest.json",
      "shard-00000.ndjson.gz",
      "shard-00001.ndjson.gz",
      "shard-00002.ndjson.gz",
    ]);
    expect(manifest.shardCount).toBe(3);
  });

  it("fails with the fdc_id of a food that does not fit the shard line", async () => {
    writeFixture({
      ...FIXTURE,
      "food.csv": csv(
        [
          "fdc_id",
          "data_type",
          "description",
          "food_category_id",
          "publication_date",
        ],
        [
          ["100", "sr_legacy_food", "Synthetic grain, raw", "20", "2019-04-01"],
          ["123", "mystery_food", "Synthetic unknown", "", "2019-04-01"],
        ],
      ),
    });
    await expect(
      buildRelease({ csvDir, release: "2026-04", outDir }),
    ).rejects.toThrow(/fdc_id 123/u);
    expect(fs.existsSync(path.join(outDir, manifestKey("2026-04")))).toBe(
      false,
    );
  });
});
