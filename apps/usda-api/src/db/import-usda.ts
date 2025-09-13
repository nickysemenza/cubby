import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { parse } from "csv-parse";
import { db, sqlite } from "./client";
import { rebuildFoodSearchFts } from "./fts";
import * as schema from "./schema";
import { sql } from "drizzle-orm";
// CSV types are used for runtime parsing but not needed for TypeScript types

const USDA_DATA_PATH = path.resolve(
  process.env.USDA_DATA_PATH ||
    path.join(os.homedir(), "dev/usda/FoodData_Central_csv_2024-10-31"),
);
const DEFAULT_BATCH_SIZE = 10000; // larger batches for better throughput

// USDA_DATA_PATH=~/dev/usda/FoodData_Central_csv_2024-10-31 pnpm run import:usda --clear --fast

interface ImportStats {
  processed: number;
  inserted: number;
  skipped: number;
}

interface SQLiteRunResult {
  changes?: number;
  lastInsertRowid?: number | bigint;
}

type DrizzlePreparedStatement = {
  run: (values: Record<string, unknown>) => {
    changes: number;
    lastInsertRowid: number | bigint;
  };
};

async function streamCsvFile<
  CsvRecord extends Record<string, unknown>,
  DbRecord extends Record<string, unknown>,
>(
  filePath: string,
  transformRecord: (record: CsvRecord) => DbRecord,
  batchSize: number = DEFAULT_BATCH_SIZE,
  drizzlePrepared: DrizzlePreparedStatement,
): Promise<ImportStats> {
  const totalRows = await countCsvRows(filePath);
  return new Promise((resolve, reject) => {
    console.log(`Streaming ${filePath}...`);
    console.log(`  Total rows: ${totalRows}`);
    const stats: ImportStats = { processed: 0, inserted: 0, skipped: 0 };
    let batch: DbRecord[] = [];
    const startTime = Date.now();

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      quote: '"',
      escape: '"',
    });

    const processBatch = () => {
      if (batch.length === 0) return;

      const doInsertBatch = () => {
        // Drizzle prepared statement per-row inside a transaction
        for (const record of batch) {
          try {
            const info = drizzlePrepared.run(record) as SQLiteRunResult;
            const changes =
              typeof info?.changes === "number" ? info.changes : 1;
            if (changes > 0) stats.inserted += 1;
            else stats.skipped += 1;
            stats.processed += 1;
          } catch (err) {
            console.warn(`Skipping record due to error:`, err);
            stats.skipped += 1;
            stats.processed += 1;
          }
        }
      };

      // Use a fast per-batch transaction
      const transaction = sqlite.transaction(doInsertBatch);
      transaction();

      if (stats.processed % (batchSize * 10) === 0) {
        const elapsedSec = Math.max(
          1,
          Math.floor((Date.now() - startTime) / 1000),
        );
        const speed = stats.processed / elapsedSec;
        const remaining = Math.max(0, totalRows - stats.processed);
        const etaSec = speed > 0 ? Math.round(remaining / speed) : 0;
        const pct =
          totalRows > 0
            ? ((stats.processed / totalRows) * 100).toFixed(1)
            : "—";
        console.log(
          `  Progress: ${stats.processed}/${totalRows} (${pct}%) | speed: ${speed.toFixed(1)} rec/s | ETA: ${formatDuration(etaSec)}`,
        );
      }

      batch = [];
    };

    parser.on("readable", function () {
      let record;
      while ((record = parser.read())) {
        try {
          const transformedRecord = transformRecord(record);
          batch.push(transformedRecord);

          if (batch.length >= batchSize) {
            processBatch();
          }
        } catch (error) {
          console.warn(`Skipping record due to transformation error:`, error);
          stats.skipped++;
          stats.processed++;
        }
      }
    });

    parser.on("error", function (err) {
      reject(err);
    });

    parser.on("end", function () {
      // Process any remaining records in the final batch
      processBatch();
      const elapsedSec = Math.max(
        1,
        Math.floor((Date.now() - startTime) / 1000),
      );
      const speed = stats.processed / elapsedSec;
      console.log(
        `Completed: ${stats.inserted} inserted, ${stats.skipped} skipped | elapsed: ${formatDuration(elapsedSec)} | avg speed: ${speed.toFixed(1)} rec/s`,
      );
      resolve(stats);
    });

    fs.createReadStream(filePath).pipe(parser);
  });
}

function convertEmptyToNull<T extends Record<string, unknown>>(obj: T): T {
  const result = {} as T;
  for (const [key, value] of Object.entries(obj)) {
    (result as Record<string, unknown>)[key] = value === "" ? null : value;
  }
  return result;
}

function parseNumber(value: string | null): number | null {
  if (!value || value.trim() === "") return null;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? null : parsed;
}

function parseInteger(value: string | null): number | null {
  if (!value || value.trim() === "") return null;
  const parsed = parseInt(value);
  return isNaN(parsed) ? null : parsed;
}

function formatDuration(totalSeconds: number): string {
  if (!isFinite(totalSeconds) || totalSeconds < 0) return "--:--:--";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function countCsvRows(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let newlineCount = 0;
    let lastByte: number | null = null;
    let sawData = false;
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => {
      sawData = true;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 10) newlineCount++; // '\n'
      }
      lastByte = buffer[buffer.length - 1];
    });
    stream.on("end", () => {
      let lineCount = newlineCount;
      if (sawData && lastByte !== 10) lineCount += 1; // count final line if no trailing newline
      const dataRows = Math.max(0, lineCount - 1); // subtract header
      resolve(dataRows);
    });
    stream.on("error", (err) => reject(err));
  });
}

async function importMeasureUnits(batchSize?: number): Promise<ImportStats> {
  console.log("\n=== Importing Measure Units ===");
  const filePath = path.join(USDA_DATA_PATH, "measure_unit.csv");

  type TransformedMeasureUnit = {
    id: number | null;
    name: string | null;
  };

  const drizzlePrepared = db
    .insert(schema.usdaMeasureUnit)
    .values({
      id: sql.placeholder("id"),
      name: sql.placeholder("name"),
    })
    .onConflictDoNothing()
    .prepare();

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        id: parseInteger(record.id as string),
        name: record.name as string,
      }) as TransformedMeasureUnit,
    batchSize,
    drizzlePrepared,
  );
}

async function importNutrients(batchSize?: number): Promise<ImportStats> {
  console.log("\n=== Importing Nutrients ===");
  const filePath = path.join(USDA_DATA_PATH, "nutrient.csv");

  type TransformedNutrient = {
    id: number | null;
    name: string | null;
    unitName: string | null;
    nutrientNbr: string | null;
    rank: string | null;
  };

  const drizzlePrepared = db
    .insert(schema.usdaNutrient)
    .values({
      id: sql.placeholder("id"),
      name: sql.placeholder("name"),
      unitName: sql.placeholder("unitName"),
      nutrientNbr: sql.placeholder("nutrientNbr"),
      rank: sql.placeholder("rank"),
    })
    .onConflictDoNothing()
    .prepare();

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        id: parseInteger(record.id as string),
        name: record.name as string,
        unitName: record.unit_name as string,
        nutrientNbr: record.nutrient_nbr as string,
        rank: record.rank as string,
      }) as TransformedNutrient,
    batchSize,
    drizzlePrepared,
  );
}

async function importFoods(batchSize?: number): Promise<ImportStats> {
  console.log("\n=== Importing Foods ===");
  const filePath = path.join(USDA_DATA_PATH, "food.csv");

  type TransformedFood = {
    fdcId: number | null;
    dataType: string | null;
    description: string | null;
    foodCategoryId: string | null;
    publicationDate: string | null;
  };

  const drizzlePrepared = db
    .insert(schema.usdaFood)
    .values({
      fdcId: sql.placeholder("fdcId"),
      dataType: sql.placeholder("dataType"),
      description: sql.placeholder("description"),
      foodCategoryId: sql.placeholder("foodCategoryId"),
      publicationDate: sql.placeholder("publicationDate"),
    })
    .onConflictDoNothing()
    .prepare();

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        fdcId: parseInteger(record.fdc_id as string),
        dataType: record.data_type,
        description: record.description,
        foodCategoryId: record.food_category_id,
        publicationDate: record.publication_date,
      }) as TransformedFood,
    batchSize,
    drizzlePrepared,
  );
}

async function importSrLegacyFoods(batchSize?: number): Promise<ImportStats> {
  console.log("\n=== Importing SR Legacy Foods ===");
  const filePath = path.join(USDA_DATA_PATH, "sr_legacy_food.csv");

  type TransformedSrLegacyFood = {
    fdcId: number | null;
    ndbNumber: number | null;
  };

  const drizzlePrepared = db
    .insert(schema.usdaSrLegacyFood)
    .values({
      fdcId: sql.placeholder("fdcId"),
      ndbNumber: sql.placeholder("ndbNumber"),
    })
    .onConflictDoNothing()
    .prepare();

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        fdcId: parseInteger(record.fdc_id as string),
        ndbNumber: parseInteger(record.NDB_number as string),
      }) as TransformedSrLegacyFood,
    batchSize,
    drizzlePrepared,
  );
}

async function importBrandedFoods(batchSize?: number): Promise<ImportStats> {
  console.log("\n=== Importing Branded Foods ===");
  const filePath = path.join(USDA_DATA_PATH, "branded_food.csv");

  type TransformedBrandedFood = {
    fdcId: number | null;
    brandOwner: string | null;
    brandName: string | null;
    subbrandName: string | null;
    gtinUpc: string | null;
    ingredients: string | null;
    notASignificantSourceOf: string | null;
    servingSize: number | null;
    servingSizeUnit: string | null;
    householdServingFulltext: string | null;
    brandedFoodCategory: string | null;
    dataSource: string | null;
    packageWeight: string | null;
    modifiedDate: string | null;
    availableDate: string | null;
    marketCountry: string | null;
    discontinuedDate: string | null;
    preparationStateCode: string | null;
    tradeChannel: string | null;
    shortDescription: string | null;
    materialCode: string | null;
  };

  const drizzlePrepared = db
    .insert(schema.usdaBrandedFood)
    .values({
      fdcId: sql.placeholder("fdcId"),
      brandOwner: sql.placeholder("brandOwner"),
      brandName: sql.placeholder("brandName"),
      subbrandName: sql.placeholder("subbrandName"),
      gtinUpc: sql.placeholder("gtinUpc"),
      ingredients: sql.placeholder("ingredients"),
      notASignificantSourceOf: sql.placeholder("notASignificantSourceOf"),
      servingSize: sql.placeholder("servingSize"),
      servingSizeUnit: sql.placeholder("servingSizeUnit"),
      householdServingFulltext: sql.placeholder("householdServingFulltext"),
      brandedFoodCategory: sql.placeholder("brandedFoodCategory"),
      dataSource: sql.placeholder("dataSource"),
      packageWeight: sql.placeholder("packageWeight"),
      modifiedDate: sql.placeholder("modifiedDate"),
      availableDate: sql.placeholder("availableDate"),
      marketCountry: sql.placeholder("marketCountry"),
      discontinuedDate: sql.placeholder("discontinuedDate"),
      preparationStateCode: sql.placeholder("preparationStateCode"),
      tradeChannel: sql.placeholder("tradeChannel"),
      shortDescription: sql.placeholder("shortDescription"),
      materialCode: sql.placeholder("materialCode"),
    })
    .onConflictDoNothing()
    .prepare();

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        fdcId: parseInteger(record.fdc_id as string),
        brandOwner: record.brand_owner,
        brandName: record.brand_name,
        subbrandName: record.subbrand_name,
        gtinUpc: record.gtin_upc,
        ingredients: record.ingredients,
        notASignificantSourceOf: record.not_a_significant_source_of,
        servingSize: parseNumber(record.serving_size as string),
        servingSizeUnit: record.serving_size_unit,
        householdServingFulltext: record.household_serving_fulltext,
        brandedFoodCategory: record.branded_food_category,
        dataSource: record.data_source,
        packageWeight: record.package_weight,
        modifiedDate: record.modified_date,
        availableDate: record.available_date,
        marketCountry: record.market_country,
        discontinuedDate: record.discontinued_date,
        preparationStateCode: record.preparation_state_code,
        tradeChannel: record.trade_channel,
        shortDescription: record.short_description,
        materialCode: record.material_code,
      }) as TransformedBrandedFood,
    batchSize,
    drizzlePrepared,
  );
}

async function importFoodNutrients(batchSize?: number): Promise<ImportStats> {
  console.log("\n=== Importing Food Nutrients ===");
  const filePath = path.join(USDA_DATA_PATH, "food_nutrient.csv");

  type TransformedFoodNutrient = {
    id: number | null;
    fdcId: number | null;
    nutrientId: number | null;
    amount: number | null;
    dataPoints: string | null;
    derivationId: string | null;
    min: string | null;
    max: string | null;
    median: string | null;
    loq: string | null;
    footnote: string | null;
    minYearAcquired: string | null;
    percentDailyValue: string | null;
  };

  const drizzlePrepared = db
    .insert(schema.usdaFoodNutrient)
    .values({
      id: sql.placeholder("id"),
      fdcId: sql.placeholder("fdcId"),
      nutrientId: sql.placeholder("nutrientId"),
      amount: sql.placeholder("amount"),
      dataPoints: sql.placeholder("dataPoints"),
      derivationId: sql.placeholder("derivationId"),
      min: sql.placeholder("min"),
      max: sql.placeholder("max"),
      median: sql.placeholder("median"),
      loq: sql.placeholder("loq"),
      footnote: sql.placeholder("footnote"),
      minYearAcquired: sql.placeholder("minYearAcquired"),
      percentDailyValue: sql.placeholder("percentDailyValue"),
    })
    .onConflictDoNothing()
    .prepare();

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        id: parseInteger(record.id as string),
        fdcId: parseInteger(record.fdc_id as string),
        nutrientId: parseInteger(record.nutrient_id as string),
        amount: parseNumber(record.amount as string),
        dataPoints: record.data_points,
        derivationId: record.derivation_id,
        min: record.min,
        max: record.max,
        median: record.median,
        loq: record.loq,
        footnote: record.footnote,
        minYearAcquired: record.min_year_acquired,
        percentDailyValue: record.percent_daily_value,
      }) as TransformedFoodNutrient,
    batchSize,
    drizzlePrepared,
  );
}

async function importFoodPortions(batchSize?: number): Promise<ImportStats> {
  console.log("\n=== Importing Food Portions ===");
  const filePath = path.join(USDA_DATA_PATH, "food_portion.csv");

  type TransformedFoodPortion = {
    id: number | null;
    fdcId: number | null;
    seqNum: string | null;
    amount: number | null;
    measureUnitId: number | null;
    portionDescription: string | null;
    modifier: string | null;
    gramWeight: number | null;
    dataPoints: string | null;
    footnote: string | null;
    minYearAcquired: string | null;
  };

  const drizzlePrepared = db
    .insert(schema.usdaFoodPortion)
    .values({
      id: sql.placeholder("id"),
      fdcId: sql.placeholder("fdcId"),
      seqNum: sql.placeholder("seqNum"),
      amount: sql.placeholder("amount"),
      measureUnitId: sql.placeholder("measureUnitId"),
      portionDescription: sql.placeholder("portionDescription"),
      modifier: sql.placeholder("modifier"),
      gramWeight: sql.placeholder("gramWeight"),
      dataPoints: sql.placeholder("dataPoints"),
      footnote: sql.placeholder("footnote"),
      minYearAcquired: sql.placeholder("minYearAcquired"),
    })
    .onConflictDoNothing()
    .prepare();

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        id: parseInteger(record.id as string),
        fdcId: parseInteger(record.fdc_id as string),
        seqNum: record.seq_num,
        amount: parseNumber(record.amount as string),
        measureUnitId: parseInteger(record.measure_unit_id as string),
        portionDescription: record.portion_description,
        modifier: record.modifier,
        gramWeight: parseNumber(record.gram_weight as string),
        dataPoints: record.data_points,
        footnote: record.footnote,
        minYearAcquired: record.min_year_acquired,
      }) as TransformedFoodPortion,
    batchSize,
    drizzlePrepared,
  );
}

function clearTables() {
  console.log("\n=== Clearing existing data ===");
  const tables = [
    "usda_food_portion",
    "usda_food_nutrient",
    "usda_branded_food",
    "usda_sr_legacy_food",
    "usda_food",
    "usda_nutrient",
    "usda_measure_unit",
  ];

  for (const table of tables) {
    try {
      sqlite.exec(`DELETE FROM ${table}`);
      console.log(`Cleared ${table}`);
    } catch {
      console.log(`Table ${table} doesn't exist or is empty`);
    }
  }
}

// (Removed index drop/recreate per request)

type PragmasSnapshot = {
  journal_mode: string | number;
  synchronous: string | number;
  temp_store: string | number;
  cache_size: number;
  mmap_size: number;
};

function applySafePragmas(): PragmasSnapshot {
  console.log("\n=== Applying safe performance PRAGMAs ===");
  const prev: PragmasSnapshot = {
    journal_mode: sqlite.pragma("journal_mode", { simple: true }) as
      | string
      | number,
    synchronous: sqlite.pragma("synchronous", { simple: true }) as
      | string
      | number,
    temp_store: sqlite.pragma("temp_store", { simple: true }) as
      | string
      | number,
    cache_size: sqlite.pragma("cache_size", { simple: true }) as number,
    mmap_size: sqlite.pragma("mmap_size", { simple: true }) as number,
  };
  try {
    sqlite.pragma("journal_mode = WAL");
  } catch {
    /* Ignore pragma errors */
  }
  try {
    sqlite.pragma("synchronous = NORMAL");
  } catch {
    /* Ignore pragma errors */
  }
  try {
    sqlite.pragma("temp_store = MEMORY");
  } catch {
    /* Ignore pragma errors */
  }
  try {
    sqlite.pragma("cache_size = -200000");
  } catch {
    /* Ignore pragma errors */
  }
  try {
    sqlite.pragma("mmap_size = 268435456");
  } catch {
    /* Ignore pragma errors */
  }
  return prev;
}

function restorePragmas(prev: PragmasSnapshot) {
  console.log("\n=== Restoring PRAGMAs ===");
  const toUpper = (v: string | number) =>
    typeof v === "string" ? v.toUpperCase() : v;
  try {
    sqlite.pragma(`journal_mode = ${toUpper(prev.journal_mode)}`);
  } catch {
    /* Ignore pragma errors */
  }
  try {
    sqlite.pragma(`synchronous = ${toUpper(prev.synchronous)}`);
  } catch {
    /* Ignore pragma errors */
  }
  try {
    sqlite.pragma(`temp_store = ${toUpper(prev.temp_store)}`);
  } catch {
    /* Ignore pragma errors */
  }
  try {
    sqlite.pragma(`cache_size = ${prev.cache_size}`);
  } catch {
    /* Ignore pragma errors */
  }
  try {
    sqlite.pragma(`mmap_size = ${prev.mmap_size}`);
  } catch {
    /* Ignore pragma errors */
  }
}

async function main() {
  const args = process.argv.slice(2);
  const shouldClear = args.includes("--clear");
  const enableSafePragmas = args.includes("--fast");
  const batchArg = args.find((a) => a.startsWith("--batch="));
  const batchSize = batchArg
    ? Math.max(
        1,
        parseInt(batchArg.split("=")[1] || "", 10) || DEFAULT_BATCH_SIZE,
      )
    : DEFAULT_BATCH_SIZE;

  console.log("Starting USDA data import...");
  console.log(`Data path: ${USDA_DATA_PATH}`);
  if (enableSafePragmas)
    console.log(
      "Fast mode: applying safe SQLite PRAGMAs (WAL, NORMAL, MEMORY, cache, mmap)",
    );
  console.log(`Batch size: ${batchSize} | Drizzle prepared statements`);

  if (shouldClear) {
    clearTables();
  }

  const previousPragmas = enableSafePragmas ? applySafePragmas() : null;

  const startTime = Date.now();
  const totalStats: ImportStats = { processed: 0, inserted: 0, skipped: 0 };

  // Import in dependency order
  const importFunctions = [
    { name: "Measure Units", fn: importMeasureUnits },
    { name: "Nutrients", fn: importNutrients },
    { name: "Foods", fn: importFoods },
    { name: "SR Legacy Foods", fn: importSrLegacyFoods },
    { name: "Branded Foods", fn: importBrandedFoods },
    { name: "Food Nutrients", fn: importFoodNutrients },
    { name: "Food Portions", fn: importFoodPortions },
  ];

  for (const { name, fn } of importFunctions) {
    try {
      const stats = await fn(batchSize);
      console.log(
        `${name}: ${stats.inserted} inserted, ${stats.skipped} skipped`,
      );
      totalStats.processed += stats.processed;
      totalStats.inserted += stats.inserted;
      totalStats.skipped += stats.skipped;
    } catch (error) {
      console.error(`Error importing ${name}:`, error);
      process.exit(1);
    }
  }

  // Import complete

  const endTime = Date.now();
  const duration = Math.round((endTime - startTime) / 1000);

  console.log("\n=== Import Complete ===");
  console.log(`Total processed: ${totalStats.processed}`);
  console.log(`Total inserted: ${totalStats.inserted}`);
  console.log(`Total skipped: ${totalStats.skipped}`);
  console.log(`Duration: ${duration} seconds`);

  // Rebuild FTS search index for fast description/name queries
  console.log("\n=== Building search index (FTS5) ===");
  try {
    rebuildFoodSearchFts();
    console.log("FTS index built");
  } catch (e) {
    console.warn("Warning: Failed to build FTS index:", e);
  }

  if (enableSafePragmas && previousPragmas) {
    restorePragmas(previousPragmas);
  }

  sqlite.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
