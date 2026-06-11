import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { TIER1_CODES } from "@cubby/usda-schemas";
import {
  assertVersion,
  bundleKey,
  bundlePrefix,
  indexTableName,
  normalizeDataType,
  searchTableName,
} from "../src/data/artifact-layout.js";
import { cliArgs } from "./lib/cli-args.js";

const D1_INSERT_BATCH_SIZE = 50;

interface FoodRow {
  fdc_id: number;
  data_type: string;
  description: string;
  brand_owner: string | null;
  brand_name: string | null;
  branded_food_category: string | null;
  gtin_upc: string | null;
  ingredients: string | null;
  serving_size: number | null;
  serving_size_unit: string | null;
  household_serving_fulltext: string | null;
  short_description: string | null;
  ndb_number: number | null;
}

interface NutrientRow {
  fdc_id: number;
  amount: number;
  name: string;
  unit: string;
  nutrient_nbr: string | null;
}

interface PortionRow {
  fdc_id: number;
  amount: number;
  modifier: string | null;
  gram_weight: number;
}

interface CliOptions {
  dbPath: string;
  outDir: string;
  version: string;
  bundleSizeBytes: number;
  limit?: number;
}

class GroupedIterator<T extends { fdc_id: number }> {
  private nextRow: T | null;

  constructor(private readonly iterator: Iterator<T>) {
    this.nextRow = this.readNext();
  }

  collect(fdcId: number): T[] {
    while (this.nextRow && this.nextRow.fdc_id < fdcId) {
      this.nextRow = this.readNext();
    }

    const rows: T[] = [];
    while (this.nextRow && this.nextRow.fdc_id === fdcId) {
      rows.push(this.nextRow);
      this.nextRow = this.readNext();
    }
    return rows;
  }

  private readNext(): T | null {
    const next = this.iterator.next();
    return next.done ? null : next.value;
  }
}

function parseArgs(): CliOptions {
  const { getArg } = cliArgs();
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const bundleSizeMb = Number(getArg("--bundle-size-mb") ?? "128");
  const limit = getArg("--limit");

  return {
    dbPath:
      getArg("--db") ??
      process.env.DATABASE_PATH ??
      path.resolve("data", "usda.sqlite"),
    outDir:
      getArg("--out") ?? path.resolve("artifacts", "usda-edge", `v${today}`),
    version: getArg("--version") ?? `v${today}`,
    bundleSizeBytes: bundleSizeMb * 1024 * 1024,
    limit: limit ? Number(limit) : undefined,
  };
}

function sqlString(value: string | number | null): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "NULL";
  return `'${value.replaceAll("'", "''")}'`;
}

async function write(
  stream: fs.WriteStream,
  text: string | Buffer,
): Promise<void> {
  if (!stream.write(text)) {
    await once(stream, "drain");
  }
}

async function close(stream: fs.WriteStream): Promise<void> {
  stream.end();
  await once(stream, "finish");
}

function tableCounts(db: Database) {
  const count = (table: string) =>
    db.prepare(`SELECT count(*) as count FROM ${table}`).get() as {
      count: number;
    };

  return {
    usda_food: count("usda_food").count,
    usda_branded_food: count("usda_branded_food").count,
    usda_nutrient: count("usda_nutrient").count,
    usda_food_nutrient: count("usda_food_nutrient").count,
    usda_measure_unit: count("usda_measure_unit").count,
    usda_food_portion: count("usda_food_portion").count,
    usda_sr_legacy_food: count("usda_sr_legacy_food").count,
  };
}

function makeFoodSummary(
  food: FoodRow,
  nutrients: NutrientRow[],
  portions: PortionRow[],
) {
  const dataType = normalizeDataType(food.data_type);

  return {
    fdc_id: food.fdc_id,
    foodInfo: {
      data_type: dataType,
      description: food.description,
    },
    brandedFoodInfo: food.gtin_upc
      ? {
          brand_owner: food.brand_owner,
          brand_name: food.brand_name,
          branded_food_category: food.branded_food_category,
          gtin_upc: food.gtin_upc,
          ingredients: food.ingredients,
          serving: {
            serving_size: food.serving_size,
            serving_size_unit: food.serving_size_unit,
            household_serving_fulltext: food.household_serving_fulltext,
          },
        }
      : null,
    legacyFoodInfo: food.ndb_number
      ? {
          ndb_number: food.ndb_number,
        }
      : null,
    nutritionInfo: {
      nutrientSummary: nutrients.map((n) => ({
        amount: n.amount,
        name: n.name,
        unit: n.unit,
      })),
      nutrientsPer100: Object.fromEntries(
        nutrients
          .filter((n) => n.nutrient_nbr && TIER1_CODES.includes(n.nutrient_nbr))
          .map((n) => [n.nutrient_nbr, n.amount]),
      ),
    },
    portionInfoRaw: portions.map((p) => ({
      amount: p.amount,
      modifier: p.modifier,
      gram_weight: p.gram_weight,
    })),
  };
}

function createSchemaSql(version: string) {
  const indexTable = indexTableName(version);
  const searchTable = searchTableName(version);

  return `CREATE TABLE IF NOT EXISTS usda_edge_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

DROP TABLE IF EXISTS ${indexTable};
DROP TABLE IF EXISTS ${searchTable};

CREATE TABLE ${indexTable} (
  fdc_id INTEGER PRIMARY KEY NOT NULL,
  data_type TEXT NOT NULL,
  description TEXT NOT NULL,
  short_description TEXT,
  brand_name TEXT,
  brand_owner TEXT,
  gtin_upc TEXT,
  ndb_number INTEGER,
  bundle_key TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ${indexTable}_gtin_upc_idx ON ${indexTable} (gtin_upc);
CREATE INDEX IF NOT EXISTS ${indexTable}_ndb_number_idx ON ${indexTable} (ndb_number);
CREATE INDEX IF NOT EXISTS ${indexTable}_data_type_idx ON ${indexTable} (data_type);
CREATE INDEX IF NOT EXISTS ${indexTable}_description_idx ON ${indexTable} (description);

CREATE VIRTUAL TABLE ${searchTable} USING fts5(
  fdc_id UNINDEXED,
  data_type UNINDEXED,
  description,
  tokenize='unicode61 remove_diacritics 1'
);
`;
}

function createFinalizeSql(version: string) {
  const searchTable = searchTableName(version);
  return `INSERT INTO ${searchTable}(${searchTable}) VALUES('optimize');
SELECT '${version}' as finalized_version;
`;
}

function createActivateSql(version: string) {
  return `INSERT OR REPLACE INTO usda_edge_meta (key, value)
VALUES ('active_version', '${version}');
`;
}

async function main() {
  const options = parseArgs();
  assertVersion(options.version);

  fs.mkdirSync(options.outDir, { recursive: true });
  const r2Root = path.join(options.outDir, "r2", "usda", options.version);
  const bundleDir = path.join(r2Root, "bundles");
  const d1Dir = path.join(options.outDir, "d1");
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.mkdirSync(d1Dir, { recursive: true });

  const db = new BetterSqlite3(options.dbPath, { readonly: true });
  db.pragma("query_only = ON");

  const counts = tableCounts(db);
  const indexTable = indexTableName(options.version);
  const searchTable = searchTableName(options.version);
  const schemaSqlPath = path.join(d1Dir, "001_schema.sql");
  const dataSqlPath = path.join(d1Dir, "002_data.sql");
  const finalizeSqlPath = path.join(d1Dir, "003_finalize.sql");
  const activateSqlPath = path.join(d1Dir, "004_activate.sql");
  const pointersPath = path.join(options.outDir, "pointers.ndjson");

  fs.writeFileSync(schemaSqlPath, createSchemaSql(options.version));
  fs.writeFileSync(finalizeSqlPath, createFinalizeSql(options.version));
  fs.writeFileSync(activateSqlPath, createActivateSql(options.version));

  const dataSql = fs.createWriteStream(dataSqlPath);
  const pointers = fs.createWriteStream(pointersPath);

  let bundleIndex = 0;
  let bundleBytes = 0;
  let currentBundleKey = bundleKey(options.version, bundleIndex);
  let bundleStream = fs.createWriteStream(
    path.join(bundleDir, path.basename(currentBundleKey)),
  );

  const rotateBundle = async () => {
    await close(bundleStream);
    bundleIndex += 1;
    bundleBytes = 0;
    currentBundleKey = bundleKey(options.version, bundleIndex);
    bundleStream = fs.createWriteStream(
      path.join(bundleDir, path.basename(currentBundleKey)),
    );
  };

  const foodSql = `
    SELECT
      f.fdc_id,
      f.data_type,
      f.description,
      b.brand_owner,
      b.brand_name,
      b.branded_food_category,
      b.gtin_upc,
      b.ingredients,
      b.serving_size,
      b.serving_size_unit,
      b.household_serving_fulltext,
      b.short_description,
      s.NDB_number as ndb_number
    FROM usda_food f
    LEFT JOIN usda_branded_food b ON b.fdc_id = f.fdc_id
    LEFT JOIN usda_sr_legacy_food s ON s.fdc_id = f.fdc_id
    ORDER BY f.fdc_id
    ${options.limit ? `LIMIT ${options.limit}` : ""}
  `;
  const nutrientSql = `
    SELECT
      fn.fdc_id,
      fn.amount,
      n.name,
      n.unit_name as unit,
      n.nutrient_nbr
    FROM usda_food_nutrient fn
    INNER JOIN usda_nutrient n ON n.id = fn.nutrient_id
    WHERE fn.fdc_id IS NOT NULL
    ORDER BY fn.fdc_id
  `;
  const portionSql = `
    SELECT fdc_id, amount, modifier, gram_weight
    FROM usda_food_portion
    WHERE fdc_id IS NOT NULL
    ORDER BY fdc_id
  `;

  const foods = db.prepare(foodSql).iterate() as IterableIterator<FoodRow>;
  const nutrients = new GroupedIterator<NutrientRow>(
    db.prepare(nutrientSql).iterate() as IterableIterator<NutrientRow>,
  );
  const portions = new GroupedIterator<PortionRow>(
    db.prepare(portionSql).iterate() as IterableIterator<PortionRow>,
  );

  let insertValues: string[] = [];
  let searchValues: string[] = [];
  let foodCount = 0;

  async function flushInserts() {
    if (insertValues.length === 0) return;
    await write(
      dataSql,
      `INSERT INTO ${indexTable} (
  fdc_id,
  data_type,
  description,
  short_description,
  brand_name,
  brand_owner,
  gtin_upc,
  ndb_number,
  bundle_key,
  byte_offset,
  byte_length
) VALUES\n${insertValues.join(",\n")};\n`,
    );
    await write(
      dataSql,
      `INSERT INTO ${searchTable} (
  fdc_id,
  data_type,
  description
) VALUES\n${searchValues.join(",\n")};\n`,
    );
    insertValues = [];
    searchValues = [];
  }

  for (const food of foods) {
    const dataType = normalizeDataType(food.data_type);
    const foodNutrients = nutrients.collect(food.fdc_id);
    const foodPortions = portions.collect(food.fdc_id);
    const line = `${JSON.stringify(
      makeFoodSummary(food, foodNutrients, foodPortions),
    )}\n`;
    const lineBytes = Buffer.byteLength(line);

    if (bundleBytes > 0 && bundleBytes + lineBytes > options.bundleSizeBytes) {
      await rotateBundle();
    }

    const byteOffset = bundleBytes;
    await write(bundleStream, line);
    bundleBytes += lineBytes;
    await write(
      pointers,
      `${JSON.stringify({
        fdc_id: food.fdc_id,
        bundle_key: currentBundleKey,
        byte_offset: byteOffset,
        byte_length: lineBytes,
      })}\n`,
    );

    insertValues.push(
      `(${[
        food.fdc_id,
        sqlString(dataType),
        sqlString(food.description),
        sqlString(food.short_description),
        sqlString(food.brand_name),
        sqlString(food.brand_owner),
        sqlString(food.gtin_upc),
        sqlString(food.ndb_number),
        sqlString(currentBundleKey),
        byteOffset,
        lineBytes,
      ].join(", ")})`,
    );
    searchValues.push(
      `(${[food.fdc_id, sqlString(dataType), sqlString(food.description)].join(
        ", ",
      )})`,
    );

    foodCount += 1;
    if (insertValues.length >= D1_INSERT_BATCH_SIZE) {
      await flushInserts();
    }
  }

  await flushInserts();
  await close(dataSql);
  await close(pointers);
  await close(bundleStream);

  const manifest = {
    version: options.version,
    schemaVersion: 1,
    source: {
      sqlitePath: path.resolve(options.dbPath),
    },
    generatedAt: new Date().toISOString(),
    counts,
    artifactCounts: {
      foods: foodCount,
      bundles: bundleIndex + 1,
    },
    bundle: {
      format: "ndjson",
      compression: "none",
      targetSizeBytes: options.bundleSizeBytes,
      prefix: bundlePrefix(options.version),
    },
  };

  fs.writeFileSync(
    path.join(r2Root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  try {
    db.close();
  } catch (error) {
    console.warn("SQLite close skipped; ordered iterators were not exhausted.");
    console.warn(error instanceof Error ? error.message : error);
  }
  console.log(`Built USDA edge artifacts in ${options.outDir}`);
  console.log(`Foods: ${foodCount}`);
  console.log(`Bundles: ${bundleIndex + 1}`);
  console.log(`D1 SQL: ${d1Dir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
