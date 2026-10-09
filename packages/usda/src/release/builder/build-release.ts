import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { z } from "zod";
import { dataTypeEnum, foodPortion } from "../../schemas";
import {
  manifestKey,
  releaseManifest,
  releaseShardLine,
  shardKey,
  type ReleaseId,
  type ReleaseManifest,
} from "../shard";
import { assembleFood } from "./assemble";
import { stageRelease } from "./staging";

const FOODS_PER_SHARD = 2000;

export interface BuildReleaseOptions {
  csvDir: string;
  release: ReleaseId;
  outDir: string;
  /** Stop after this many emitted foods (a partial release, for trials). */
  limit?: number;
  foodsPerShard?: number;
  scratchDir?: string;
  log?: (message: string) => void;
}

export interface BuildReleaseResult {
  manifest: ReleaseManifest;
  lineCount: number;
  uncompressedBytes: number;
  gzipBytes: number;
  /** UTF-8 byte length of every line, newline included, in emit order. */
  lineBytes: Uint32Array;
}

const stagedFood = z.object({
  fdc_id: z.number().int(),
  data_type: z.string(),
  description: z.string(),
  gtin_upc: z.string().nullable(),
  brand_owner: z.string().nullable(),
  brand_name: z.string().nullable(),
  branded_food_category: z.string().nullable(),
  ingredients: z.string().nullable(),
  serving_size: z.number().nullable(),
  serving_size_unit: z.string().nullable(),
  household_serving_fulltext: z.string().nullable(),
  ndb_number: z.number().int().nullable(),
});

const stagedNutrient = z.object({
  amount: z.number(),
  name: z.string(),
  unit: z.string(),
  nutrient_nbr: z.string().nullable(),
});

/**
 * Build one USDA release from an FDC CSV download into gzipped NDJSON shards
 * plus `manifest.json` under `<outDir>/<release>/` (the R2 layout in
 * `../shard`). The release directory is replaced only after every line has
 * validated, so a failed build leaves the previous one intact.
 */
export async function buildRelease(
  options: BuildReleaseOptions,
): Promise<BuildReleaseResult> {
  const log = options.log ?? (() => {});
  const foodsPerShard = options.foodsPerShard ?? FOODS_PER_SHARD;
  const scratch = fs.mkdtempSync(
    path.join(options.scratchDir ?? os.tmpdir(), "usda-release-"),
  );
  fs.mkdirSync(options.outDir, { recursive: true });
  const staging = fs.mkdtempSync(
    path.join(options.outDir, `.${options.release}-building-`),
  );
  const scratchFile = path.join(scratch, "stage.sqlite");
  let db: Database.Database | null = null;
  let reader: Database.Database | null = null;
  try {
    db = await stageRelease(options.csvDir, scratchFile, log);
    reader = new Database(scratchFile, { readonly: true });

    const nutrientsOf = db.prepare(`
      SELECT fn.amount, n.name, n.unit, n.nutrient_nbr
      FROM food_nutrient fn JOIN nutrient n ON n.id = fn.nutrient_id
      WHERE fn.fdc_id = ? ORDER BY fn.id`);
    const portionsOf = db.prepare(`
      SELECT amount, modifier, gram_weight FROM food_portion
      WHERE fdc_id = ? ORDER BY id`);
    const supersededOf = db
      .prepare(
        "SELECT fdc_id FROM superseded WHERE current_fdc_id = ? ORDER BY fdc_id",
      )
      .pluck();
    const foods = reader.prepare(`
      SELECT f.fdc_id, f.data_type, f.description, b.gtin_upc, b.brand_owner,
        b.brand_name, b.branded_food_category, b.ingredients, b.serving_size,
        b.serving_size_unit, b.household_serving_fulltext, l.ndb_number
      FROM food f
      LEFT JOIN branded b ON b.fdc_id = f.fdc_id
      LEFT JOIN legacy l ON l.fdc_id = f.fdc_id
      WHERE f.fdc_id NOT IN (SELECT fdc_id FROM superseded)
      ORDER BY f.fdc_id
      ${options.limit === undefined ? "" : `LIMIT ${Math.trunc(options.limit)}`}`);

    const foodsByDataType = z
      .record(dataTypeEnum, z.number())
      .parse(Object.fromEntries(dataTypeEnum.options.map((type) => [type, 0])));
    let supersededCount = 0;
    let shardCount = 0;
    let uncompressedBytes = 0;
    let gzipBytes = 0;
    let lineBytes = new Uint32Array(1 << 20);
    let lineCount = 0;
    let shard: string[] = [];

    const flushShard = () => {
      if (shard.length === 0) return;
      const file = path.join(staging, shardKey(options.release, shardCount));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const gz = zlib.gzipSync(shard.join(""));
      fs.writeFileSync(file, gz);
      gzipBytes += gz.byteLength;
      shardCount++;
      shard = [];
    };

    const started = Date.now();
    for (const row of foods.iterate()) {
      const food = stagedFood.parse(row);
      const candidate = {
        food: assembleFood(
          food,
          nutrientsOf.all(food.fdc_id).map((n) => stagedNutrient.parse(n)),
          portionsOf.all(food.fdc_id).map((p) => foodPortion.parse(p)),
        ),
        supersededFdcIds: supersededOf.all(food.fdc_id),
      };
      const parsed = releaseShardLine.safeParse(candidate);
      if (!parsed.success) {
        throw new Error(
          `fdc_id ${food.fdc_id} is not a valid release shard line:\n${z.prettifyError(parsed.error)}`,
        );
      }
      const line = `${JSON.stringify(parsed.data)}\n`;
      const bytes = Buffer.byteLength(line);
      if (lineCount === lineBytes.length) {
        const grown = new Uint32Array(lineBytes.length * 2);
        grown.set(lineBytes);
        lineBytes = grown;
      }
      lineBytes[lineCount++] = bytes;
      uncompressedBytes += bytes;
      foodsByDataType[parsed.data.food.foodInfo.data_type]++;
      supersededCount += parsed.data.supersededFdcIds.length;
      shard.push(line);
      if (shard.length >= foodsPerShard) flushShard();
      if (lineCount % 100_000 === 0) {
        log(
          `emitted ${lineCount} foods in ${((Date.now() - started) / 1000).toFixed(1)}s`,
        );
      }
    }
    flushShard();

    const manifest = releaseManifest.parse({
      release: options.release,
      shardCount,
      foodsByDataType,
      supersededCount,
    });
    fs.writeFileSync(
      path.join(staging, manifestKey(options.release)),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const target = path.join(options.outDir, options.release);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(path.join(staging, options.release), target);

    return {
      manifest,
      lineCount,
      uncompressedBytes,
      gzipBytes,
      lineBytes: lineBytes.slice(0, lineCount),
    };
  } finally {
    reader?.close();
    db?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
