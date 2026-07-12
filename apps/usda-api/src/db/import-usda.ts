import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { parse } from "csv-parse";
import { db, sqlite } from "./client";
import { rebuildFoodSearchFts } from "./fts";
import * as schema from "./schema";
import { sql } from "drizzle-orm";
import type { SQLiteInsertValue, SQLiteTable } from "drizzle-orm/sqlite-core";
import type {
  MeasureUnitCsvRecord,
  NutrientCsvRecord,
  FoodCsvRecord,
  SrLegacyFoodCsvRecord,
  BrandedFoodCsvRecord,
  FoodNutrientCsvRecord,
  FoodPortionCsvRecord,
} from "./csv-types";

const USDA_DATA_PATH = path.resolve(
  process.env.USDA_DATA_PATH ||
    path.join(os.homedir(), "dev/usda/FoodData_Central_csv_2024-10-31"),
);
const DEFAULT_BATCH_SIZE = 5000; // larger batches for better throughput

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

// Field mappings and transformations for each table
type FieldTransformValue = "string" | "number" | "integer";

interface TableConfig<TCsv, TSchema extends SQLiteTable> {
  tableName: string;
  csvFile: string;
  schema: TSchema;
  transforms: Partial<Record<keyof TCsv, FieldTransformValue>>;
  // When set, records missing any of these fields (null/undefined) are skipped
  requiredNonNull?: Array<keyof TCsv>;
  // When provided, empty string values for these fields will be replaced
  // with the specified non-empty string BEFORE converting empties to nulls.
  // Useful to preserve rows where NOT NULL constraints are required but
  // source CSV sometimes contains empty strings (e.g., food.description).
  fillEmptyWith?: Partial<Record<keyof TCsv, string>>;
}

// Configuration for each import table
const measureUnitConfig: TableConfig<
  MeasureUnitCsvRecord,
  typeof schema.usdaMeasureUnit
> = {
  tableName: "Measure Units",
  csvFile: "measure_unit.csv",
  schema: schema.usdaMeasureUnit,
  transforms: {
    id: "integer",
  },
};

const nutrientConfig: TableConfig<
  NutrientCsvRecord,
  typeof schema.usdaNutrient
> = {
  tableName: "Nutrients",
  csvFile: "nutrient.csv",
  schema: schema.usdaNutrient,
  transforms: {
    id: "integer",
  },
};

const foodConfig: TableConfig<FoodCsvRecord, typeof schema.usdaFood> = {
  tableName: "Foods",
  csvFile: "food.csv",
  schema: schema.usdaFood,
  transforms: {
    fdc_id: "integer",
  },
  requiredNonNull: ["description"],
  // If description is empty in CSV, preserve row by using a placeholder
  // to satisfy NOT NULL constraints and retain referential integrity.
  fillEmptyWith: { description: "<empty>" },
};

const srLegacyFoodConfig: TableConfig<
  SrLegacyFoodCsvRecord,
  typeof schema.usdaSrLegacyFood
> = {
  tableName: "SR Legacy Foods",
  csvFile: "sr_legacy_food.csv",
  schema: schema.usdaSrLegacyFood,
  transforms: {
    fdc_id: "integer",
    NDB_number: "integer",
  },
};

const brandedFoodConfig: TableConfig<
  BrandedFoodCsvRecord,
  typeof schema.usdaBrandedFood
> = {
  tableName: "Branded Foods",
  csvFile: "branded_food.csv",
  schema: schema.usdaBrandedFood,
  transforms: {
    fdc_id: "integer",
    serving_size: "number",
  },
};

const foodNutrientConfig: TableConfig<
  FoodNutrientCsvRecord,
  typeof schema.usdaFoodNutrient
> = {
  tableName: "Food Nutrients",
  csvFile: "food_nutrient.csv",
  schema: schema.usdaFoodNutrient,
  transforms: {
    id: "integer",
    fdc_id: "integer",
    nutrient_id: "integer",
    amount: "number",
  },
  requiredNonNull: ["amount"],
};

const foodPortionConfig: TableConfig<
  FoodPortionCsvRecord,
  typeof schema.usdaFoodPortion
> = {
  tableName: "Food Portions",
  csvFile: "food_portion.csv",
  schema: schema.usdaFoodPortion,
  transforms: {
    id: "integer",
    fdc_id: "integer",
    amount: "number",
    measure_unit_id: "integer",
    gram_weight: "number",
  },
  requiredNonNull: ["amount", "gram_weight"],
};

// Generic transformation utilities
function transformField(
  value: string,
  transformType: FieldTransformValue,
): string | number | null {
  switch (transformType) {
    case "integer":
      return parseInteger(value);
    case "number":
      return parseNumber(value);
    default:
      return value;
  }
}

function transformRecord<
  TCsv extends Record<string, unknown>,
  TSchema extends SQLiteTable,
>(
  csvRecord: TCsv,
  config: TableConfig<TCsv, TSchema>,
): Record<string, unknown> {
  const result = {} as Record<string, unknown>;

  for (const csvField in csvRecord) {
    const csvValue = csvRecord[csvField] as string;
    const transformType = config.transforms[csvField as keyof TCsv] || "string";
    // If the source value is an empty string and a fill value is configured
    // for this field, use the non-empty placeholder instead of converting
    // it to null. This happens BEFORE the generic empty-to-null pass below.
    const fillValue = config.fillEmptyWith?.[csvField as keyof TCsv] as
      | string
      | undefined;
    if (csvValue === "" && typeof fillValue === "string") {
      result[csvField] = fillValue;
    } else {
      const transformedValue = transformField(
        csvValue,
        transformType as FieldTransformValue,
      );
      result[csvField] = transformedValue;
    }
  }

  return convertEmptyToNull(result);
}

// Helper function to parse CSV header and get field names
async function getCsvFieldNames(filePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      to_line: 2, // Need to read 2 lines: when columns=true, the first line becomes headers
      // and the parser only emits records starting from the second line
    });

    let fieldNames: string[] = [];

    parser.on("readable", () => {
      const record = parser.read();
      if (record && fieldNames.length === 0) {
        fieldNames = Object.keys(record);
      }
    });

    parser.on("end", () => {
      resolve(fieldNames);
    });

    parser.on("error", (err) => {
      reject(err);
    });

    const fileStream = fs.createReadStream(filePath);

    fileStream.on("error", (err) => {
      reject(err);
    });

    fileStream.pipe(parser);
  });
}

// Generic import factory function
function createImporter<
  TCsv extends Record<string, unknown>,
  TSchema extends SQLiteTable,
>(config: TableConfig<TCsv, TSchema>) {
  return async (batchSize?: number): Promise<ImportStats> => {
    console.log(`\n=== Importing ${config.tableName} ===`);
    const filePath = path.join(USDA_DATA_PATH, config.csvFile);

    try {
      // Parse CSV header to get field names
      const csvFieldNames = await getCsvFieldNames(filePath);

      // Create placeholder values for all fields
      const placeholderValues = {} as Record<string, unknown>;
      for (const csvField of csvFieldNames) {
        placeholderValues[csvField] = sql.placeholder(csvField);
      }

      const drizzlePrepared = db
        .insert(config.schema)
        .values(placeholderValues as SQLiteInsertValue<TSchema>)
        .onConflictDoNothing()
        .prepare();

      // Optional filter for required non-null fields
      const shouldInclude = config.requiredNonNull
        ? (rec: Record<string, unknown>) =>
            config.requiredNonNull!.every((k) => rec[k as string] !== null)
        : undefined;

      return streamCsvFile(
        filePath,
        (csvRecord: TCsv) => transformRecord(csvRecord, config),
        batchSize,
        drizzlePrepared,
        shouldInclude,
      );
    } catch (error) {
      console.error(`Error importing ${config.tableName}:`, error);
      throw error;
    }
  };
}

async function streamCsvFile<
  CsvRecord extends Record<string, unknown>,
  DbRecord extends Record<string, unknown>,
>(
  filePath: string,
  transformRecord: (record: CsvRecord) => DbRecord,
  batchSize: number = DEFAULT_BATCH_SIZE,
  drizzlePrepared: DrizzlePreparedStatement,
  shouldInclude?: (record: DbRecord) => boolean,
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
            // Always print the offending record for easier diagnostics
            console.warn(
              `Skipping record due to error: ${
                err instanceof Error ? err.message : String(err)
              }\n  record: ${JSON.stringify(record)}`,
            );
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

    parser.on("readable", () => {
      let record: CsvRecord | null = parser.read() as CsvRecord | null;
      while (record !== null) {
        try {
          const transformedRecord = transformRecord(record);
          if (shouldInclude && !shouldInclude(transformedRecord)) {
            stats.skipped++;
            stats.processed++;
            continue;
          }
          batch.push(transformedRecord);

          if (batch.length >= batchSize) {
            processBatch();
          }
        } catch (error) {
          console.warn(`Skipping record due to transformation error:`, error);
          stats.skipped++;
          stats.processed++;
        }
        record = parser.read() as CsvRecord | null;
      }
    });

    parser.on("error", (err) => {
      reject(err);
    });

    parser.on("end", () => {
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
  return Number.isNaN(parsed) ? null : parsed;
}

function parseInteger(value: string | null): number | null {
  if (!value || value.trim() === "") return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "--:--:--";
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
      lastByte = buffer[buffer.length - 1] ?? null;
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

// Create import functions using the factory
const importMeasureUnits = createImporter(measureUnitConfig);
const importNutrients = createImporter(nutrientConfig);
const importFoods = createImporter(foodConfig);
const importSrLegacyFoods = createImporter(srLegacyFoodConfig);
const importBrandedFoods = createImporter(brandedFoodConfig);
const importFoodNutrients = createImporter(foodNutrientConfig);
const importFoodPortions = createImporter(foodPortionConfig);

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
