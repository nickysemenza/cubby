import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { parse } from "csv-parse";
import { z } from "zod";
import { db, sqlite } from "./client";
import { rebuildFoodSearchFts } from "./fts";
import * as schema from "./schema";
import { sql } from "drizzle-orm";
import type { SQLiteInsertValue, SQLiteTable } from "drizzle-orm/sqlite-core";

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

type DrizzlePreparedStatement = {
  run: (values: DatabaseRecord) => {
    changes: number;
    lastInsertRowid: number | bigint;
  };
};

type FieldTransformValue = "string" | "number" | "integer";
type CsvRecord = Record<string, string>;
type DatabaseValue = string | number | null;
type DatabaseRecord = Record<string, DatabaseValue>;
const csvRecordSchema = z.record(z.string(), z.string());

interface TableConfig<TSchema extends SQLiteTable> {
  tableName: string;
  csvFile: string;
  schema: TSchema;
  transforms: Record<string, FieldTransformValue>;
  // When set, records missing any of these fields (null/undefined) are skipped
  requiredNonNull?: string[];
  // When provided, empty string values for these fields will be replaced
  // with the specified non-empty string BEFORE converting empties to nulls.
  // Useful to preserve rows where NOT NULL constraints are required but
  // source CSV sometimes contains empty strings (e.g., food.description).
  fillEmptyWith?: Record<string, string>;
}

const measureUnitConfig: TableConfig<typeof schema.usdaMeasureUnit> = {
  tableName: "Measure Units",
  csvFile: "measure_unit.csv",
  schema: schema.usdaMeasureUnit,
  transforms: {
    id: "integer",
  },
};

const nutrientConfig: TableConfig<typeof schema.usdaNutrient> = {
  tableName: "Nutrients",
  csvFile: "nutrient.csv",
  schema: schema.usdaNutrient,
  transforms: {
    id: "integer",
  },
};

const foodConfig: TableConfig<typeof schema.usdaFood> = {
  tableName: "Foods",
  csvFile: "food.csv",
  schema: schema.usdaFood,
  transforms: {
    fdc_id: "integer",
  },
  requiredNonNull: ["description"],
  fillEmptyWith: { description: "<empty>" },
};

const srLegacyFoodConfig: TableConfig<typeof schema.usdaSrLegacyFood> = {
  tableName: "SR Legacy Foods",
  csvFile: "sr_legacy_food.csv",
  schema: schema.usdaSrLegacyFood,
  transforms: {
    fdc_id: "integer",
    NDB_number: "integer",
  },
};

const brandedFoodConfig: TableConfig<typeof schema.usdaBrandedFood> = {
  tableName: "Branded Foods",
  csvFile: "branded_food.csv",
  schema: schema.usdaBrandedFood,
  transforms: {
    fdc_id: "integer",
    serving_size: "number",
  },
};

const foodNutrientConfig: TableConfig<typeof schema.usdaFoodNutrient> = {
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

const foodPortionConfig: TableConfig<typeof schema.usdaFoodPortion> = {
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

function transformRecord<TSchema extends SQLiteTable>(
  csvRecord: CsvRecord,
  config: TableConfig<TSchema>,
): DatabaseRecord {
  const result: DatabaseRecord = {};

  for (const [csvField, csvValue] of Object.entries(csvRecord)) {
    const transformType =
      Object.entries(config.transforms).find(
        ([field]) => field === csvField,
      )?.[1] ?? "string";
    // If the source value is an empty string and a fill value is configured
    // for this field, use the non-empty placeholder instead of converting
    // it to null. This happens BEFORE the generic empty-to-null pass below.
    const fillValue = Object.entries(config.fillEmptyWith ?? {}).find(
      ([field]) => field === csvField,
    )?.[1];
    if (csvValue === "" && fillValue !== undefined) {
      result[csvField] = fillValue;
    } else {
      const transformedValue = transformField(csvValue, transformType);
      result[csvField] = transformedValue;
    }
  }

  return convertEmptyToNull(result);
}

async function getCsvFieldNames(filePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      to_line: 2,
    });

    let fieldNames: string[] = [];

    parser.on("readable", () => {
      const record = parser.read();
      if (record && fieldNames.length === 0) {
        fieldNames = Object.keys(csvRecordSchema.parse(record));
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

function createImporter<TSchema extends SQLiteTable>(
  config: TableConfig<TSchema>,
) {
  return async (batchSize?: number): Promise<ImportStats> => {
    console.log(`\n=== Importing ${config.tableName} ===`);
    const filePath = path.join(USDA_DATA_PATH, config.csvFile);

    try {
      const csvFieldNames = await getCsvFieldNames(filePath);

      const placeholderValues: Record<
        string,
        ReturnType<typeof sql.placeholder>
      > = {};
      for (const csvField of csvFieldNames) {
        placeholderValues[csvField] = sql.placeholder(csvField);
      }

      const drizzlePrepared = db
        .insert(config.schema)
        .values(
          // SAFETY: csv headers are validated against this table's columns by
          // the prepared insert; placeholders use those exact header names.
          placeholderValues as SQLiteInsertValue<TSchema>,
        )
        .onConflictDoNothing()
        .prepare();

      const requiredNonNull = config.requiredNonNull;
      const shouldInclude = requiredNonNull
        ? (rec: DatabaseRecord) =>
            requiredNonNull.every((key) => rec[String(key)] !== null)
        : undefined;

      return streamCsvFile(
        filePath,
        (csvRecord) => transformRecord(csvRecord, config),
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

async function streamCsvFile(
  filePath: string,
  transformRecord: (record: CsvRecord) => DatabaseRecord,
  batchSize: number = DEFAULT_BATCH_SIZE,
  drizzlePrepared: DrizzlePreparedStatement,
  shouldInclude?: (record: DatabaseRecord) => boolean,
): Promise<ImportStats> {
  const totalRows = await countCsvRows(filePath);
  return new Promise((resolve, reject) => {
    console.log(`Streaming ${filePath}...`);
    console.log(`  Total rows: ${totalRows}`);
    const stats: ImportStats = { processed: 0, inserted: 0, skipped: 0 };
    let batch: DatabaseRecord[] = [];
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
        for (const record of batch) {
          try {
            const info = drizzlePrepared.run(record);
            const changes = info.changes;
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
      let record: CsvRecord | null = null;
      const firstRecord = parser.read();
      if (firstRecord !== null) record = csvRecordSchema.parse(firstRecord);
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
        const nextRecord = parser.read();
        record = nextRecord === null ? null : csvRecordSchema.parse(nextRecord);
      }
    });

    parser.on("error", (err) => {
      reject(err);
    });

    parser.on("end", () => {
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

function convertEmptyToNull(obj: DatabaseRecord) {
  const result: DatabaseRecord = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = value === "" ? null : value;
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

type PragmasSnapshot = {
  journal_mode: string | number;
  synchronous: string | number;
  temp_store: string | number;
  cache_size: number;
  mmap_size: number;
};

const pragmaValueSchema = z.union([z.string(), z.number()]);
type PragmaValue = z.infer<typeof pragmaValueSchema>;

const readPragmaValue = (name: string): PragmaValue =>
  pragmaValueSchema.parse(sqlite.pragma(name, { simple: true }));

const readNumericPragma = (name: string): number =>
  z.number().parse(sqlite.pragma(name, { simple: true }));

function applySafePragmas(): PragmasSnapshot {
  console.log("\n=== Applying safe performance PRAGMAs ===");
  const prev: PragmasSnapshot = {
    journal_mode: readPragmaValue("journal_mode"),
    synchronous: readPragmaValue("synchronous"),
    temp_store: readPragmaValue("temp_store"),
    cache_size: readNumericPragma("cache_size"),
    mmap_size: readNumericPragma("mmap_size"),
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
  const toUpper = (value: PragmaValue): PragmaValue => {
    const textValue = z.string().safeParse(value);
    return textValue.success ? textValue.data.toUpperCase() : value;
  };
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

  const endTime = Date.now();
  const duration = Math.round((endTime - startTime) / 1000);

  console.log("\n=== Import Complete ===");
  console.log(`Total processed: ${totalStats.processed}`);
  console.log(`Total inserted: ${totalStats.inserted}`);
  console.log(`Total skipped: ${totalStats.skipped}`);
  console.log(`Duration: ${duration} seconds`);

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
