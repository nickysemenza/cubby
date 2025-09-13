import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { parse } from "csv-parse";
import { db, sqlite } from "./client.js";
import { rebuildFoodSearchFts } from "./fts.js";
import {
  usdaFood,
  usdaNutrient,
  usdaFoodNutrient,
  usdaBrandedFood,
  usdaMeasureUnit,
  usdaFoodPortion,
  usdaSrLegacyFood,
} from "./schema.js";

const USDA_DATA_PATH = path.resolve(
  process.env.USDA_DATA_PATH || path.join(os.homedir(), "dev/usda/FoodData_Central_csv_2024-10-31")
);
const DEFAULT_BATCH_SIZE = 10000; // larger batches for better throughput

interface ImportStats {
  processed: number;
  inserted: number;
  skipped: number;
}

type RawPrepared = {
  sql: string;
  mapParams: (record: any) => any[];
};

type ImportOptions = {
  batchSize?: number;
  useRaw?: boolean;
  rawPrepared?: RawPrepared;
};

interface SQLiteRunResult {
  changes?: number;
  lastInsertRowid?: number;
}

type PragmaValue = string | number;

async function streamCsvFile<T extends Record<string, any>>(
  filePath: string,
  transformRecord: (record: any) => T,
  table: any,
  batchSize: number = DEFAULT_BATCH_SIZE,
  opts: ImportOptions = {}
): Promise<ImportStats> {
  const totalRows = await countCsvRows(filePath);
  return new Promise((resolve, reject) => {
    console.log(`Streaming ${filePath}...`);
    console.log(`  Total rows: ${totalRows}`);
    const stats: ImportStats = { processed: 0, inserted: 0, skipped: 0 };
    let batch: T[] = [];
    const startTime = Date.now();

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      quote: '"',
      escape: '"',
    });

    const preparedStmt = opts.rawPrepared ? sqlite.prepare(opts.rawPrepared.sql) : null;

    const processBatch = () => {
      if (batch.length === 0) return;

      const doInsertBatch = () => {
        if (preparedStmt && opts.rawPrepared) {
          // Raw prepared per-row inside a transaction
          for (const record of batch) {
            try {
              const info = preparedStmt.run(opts.rawPrepared.mapParams(record)) as SQLiteRunResult;
              const changes = typeof info?.changes === 'number' ? info.changes : 1;
              if (changes > 0) stats.inserted += 1; else stats.skipped += 1;
              stats.processed += 1;
            } catch (err) {
              console.warn(`Skipping record due to error:`, err);
              stats.skipped += 1;
              stats.processed += 1;
            }
          }
        } else {
          try {
            const result = db
              .insert(table)
              .values(batch)
              .onConflictDoNothing()
              .run() as SQLiteRunResult;
            const changes = typeof result?.changes === 'number' ? result.changes : batch.length;
            stats.inserted += changes;
            stats.skipped += batch.length - changes;
            stats.processed += batch.length;
          } catch (error) {
            // Fallback to per-row to salvage good records and log offenders
            for (const record of batch) {
              try {
                db.insert(table).values(record).onConflictDoNothing().run();
                stats.inserted++;
              } catch (err) {
                console.warn(`Skipping record due to error:`, err);
                stats.skipped++;
              }
              stats.processed++;
            }
          }
        }
      };

      // Use a fast per-batch transaction
      const transaction = sqlite.transaction(doInsertBatch);
      transaction();

      if (stats.processed % (batchSize * 10) === 0) {
        const elapsedSec = Math.max(1, Math.floor((Date.now() - startTime) / 1000));
        const speed = stats.processed / elapsedSec;
        const remaining = Math.max(0, totalRows - stats.processed);
        const etaSec = speed > 0 ? Math.round(remaining / speed) : 0;
        const pct = totalRows > 0 ? ((stats.processed / totalRows) * 100).toFixed(1) : "—";
        console.log(
          `  Progress: ${stats.processed}/${totalRows} (${pct}%) | speed: ${speed.toFixed(1)} rec/s | ETA: ${formatDuration(etaSec)}`
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

    parser.on("error", function (err) { reject(err); });

    parser.on("end", function () {
      // Process any remaining records in the final batch
      processBatch();
      const elapsedSec = Math.max(1, Math.floor((Date.now() - startTime) / 1000));
      const speed = stats.processed / elapsedSec;
      console.log(
        `Completed: ${stats.inserted} inserted, ${stats.skipped} skipped | elapsed: ${formatDuration(elapsedSec)} | avg speed: ${speed.toFixed(1)} rec/s`
      );
      resolve(stats);
    });

    fs.createReadStream(filePath).pipe(parser);
  });
}

function convertEmptyToNull(obj: any): any {
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = value === "" ? null : value;
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

async function importMeasureUnits(batchSize?: number, opts: ImportOptions = {}): Promise<ImportStats> {
  console.log("\n=== Importing Measure Units ===");
  const filePath = path.join(USDA_DATA_PATH, "measure_unit.csv");
  const raw = opts.useRaw
    ? {
        sql: "INSERT OR IGNORE INTO usda_measure_unit (id, name) VALUES (?, ?)",
        mapParams: (r: any) => [r.id, r.name],
      }
    : undefined;

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        id: parseInteger(record.id),
        name: record.name,
      }),
    usdaMeasureUnit,
    batchSize,
    { ...opts, rawPrepared: raw }
  );
}

async function importNutrients(batchSize?: number, opts: ImportOptions = {}): Promise<ImportStats> {
  console.log("\n=== Importing Nutrients ===");
  const filePath = path.join(USDA_DATA_PATH, "nutrient.csv");
  const raw = opts.useRaw
    ? {
        sql: "INSERT OR IGNORE INTO usda_nutrient (id, name, unit_name, nutrient_nbr, rank) VALUES (?, ?, ?, ?, ?)",
        mapParams: (r: any) => [r.id, r.name, r.unitName, r.nutrientNbr, r.rank],
      }
    : undefined;

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        id: parseInteger(record.id),
        name: record.name,
        unitName: record.unit_name,
        nutrientNbr: record.nutrient_nbr,
        rank: record.rank,
      }),
    usdaNutrient,
    batchSize,
    { ...opts, rawPrepared: raw }
  );
}

async function importFoods(batchSize?: number, opts: ImportOptions = {}): Promise<ImportStats> {
  console.log("\n=== Importing Foods ===");
  const filePath = path.join(USDA_DATA_PATH, "food.csv");
  const raw = opts.useRaw
    ? {
        sql: "INSERT OR IGNORE INTO usda_food (fdc_id, data_type, description, food_category_id, publication_date) VALUES (?, ?, ?, ?, ?)",
        mapParams: (r: any) => [r.fdcId, r.dataType, r.description, r.foodCategoryId, r.publicationDate],
      }
    : undefined;

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        fdcId: parseInteger(record.fdc_id),
        dataType: record.data_type,
        description: record.description,
        foodCategoryId: record.food_category_id,
        publicationDate: record.publication_date,
      }),
    usdaFood,
    batchSize,
    { ...opts, rawPrepared: raw }
  );
}

async function importSrLegacyFoods(batchSize?: number, opts: ImportOptions = {}): Promise<ImportStats> {
  console.log("\n=== Importing SR Legacy Foods ===");
  const filePath = path.join(USDA_DATA_PATH, "sr_legacy_food.csv");
  const raw = opts.useRaw
    ? {
        sql: "INSERT OR IGNORE INTO usda_sr_legacy_food (fdc_id, NDB_number) VALUES (?, ?)",
        mapParams: (r: any) => [r.fdcId, r.ndbNumber],
      }
    : undefined;

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        fdcId: parseInteger(record.fdc_id),
        ndbNumber: parseInteger(record.NDB_number),
      }),
    usdaSrLegacyFood,
    batchSize,
    { ...opts, rawPrepared: raw }
  );
}

async function importBrandedFoods(batchSize?: number, opts: ImportOptions = {}): Promise<ImportStats> {
  console.log("\n=== Importing Branded Foods ===");
  const filePath = path.join(USDA_DATA_PATH, "branded_food.csv");
  const raw = opts.useRaw
    ? {
        sql: "INSERT OR IGNORE INTO usda_branded_food (fdc_id, brand_owner, brand_name, subbrand_name, gtin_upc, ingredients, not_a_significant_source_of, serving_size, serving_size_unit, household_serving_fulltext, branded_food_category, data_source, package_weight, modified_date, available_date, market_country, discontinued_date, preparation_state_code, trade_channel, short_description, material_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        mapParams: (r: any) => [
          r.fdcId,
          r.brandOwner,
          r.brandName,
          r.subbrandName,
          r.gtinUpc,
          r.ingredients,
          r.notASignificantSourceOf,
          r.servingSize,
          r.servingSizeUnit,
          r.householdServingFulltext,
          r.brandedFoodCategory,
          r.dataSource,
          r.packageWeight,
          r.modifiedDate,
          r.availableDate,
          r.marketCountry,
          r.discontinuedDate,
          r.preparationStateCode,
          r.tradeChannel,
          r.shortDescription,
          r.materialCode,
        ],
      }
    : undefined;

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        fdcId: parseInteger(record.fdc_id),
        brandOwner: record.brand_owner,
        brandName: record.brand_name,
        subbrandName: record.subbrand_name,
        gtinUpc: record.gtin_upc,
        ingredients: record.ingredients,
        notASignificantSourceOf: record.not_a_significant_source_of,
        servingSize: parseNumber(record.serving_size),
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
      }),
    usdaBrandedFood,
    batchSize,
    { ...opts, rawPrepared: raw }
  );
}

async function importFoodNutrients(batchSize?: number, opts: ImportOptions = {}): Promise<ImportStats> {
  console.log("\n=== Importing Food Nutrients ===");
  const filePath = path.join(USDA_DATA_PATH, "food_nutrient.csv");
  const raw = opts.useRaw
    ? {
        sql: "INSERT OR IGNORE INTO usda_food_nutrient (id, fdc_id, nutrient_id, amount, data_points, derivation_id, min, max, median, loq, footnote, min_year_acquired, percent_daily_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        mapParams: (r: any) => [
          r.id,
          r.fdcId,
          r.nutrientId,
          r.amount,
          r.dataPoints,
          r.derivationId,
          r.min,
          r.max,
          r.median,
          r.loq,
          r.footnote,
          r.minYearAcquired,
          r.percentDailyValue,
        ],
      }
    : undefined;

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        id: parseInteger(record.id),
        fdcId: parseInteger(record.fdc_id),
        nutrientId: parseInteger(record.nutrient_id),
        amount: parseNumber(record.amount),
        dataPoints: record.data_points,
        derivationId: record.derivation_id,
        min: record.min,
        max: record.max,
        median: record.median,
        loq: record.loq,
        footnote: record.footnote,
        minYearAcquired: record.min_year_acquired,
        percentDailyValue: record.percent_daily_value,
      }),
    usdaFoodNutrient,
    batchSize,
    { ...opts, rawPrepared: raw }
  );
}

async function importFoodPortions(batchSize?: number, opts: ImportOptions = {}): Promise<ImportStats> {
  console.log("\n=== Importing Food Portions ===");
  const filePath = path.join(USDA_DATA_PATH, "food_portion.csv");
  const raw = opts.useRaw
    ? {
        sql: "INSERT OR IGNORE INTO usda_food_portion (id, fdc_id, seq_num, amount, measure_unit_id, portion_description, modifier, gram_weight, data_points, footnote, min_year_acquired) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        mapParams: (r: any) => [
          r.id,
          r.fdcId,
          r.seqNum,
          r.amount,
          r.measureUnitId,
          r.portionDescription,
          r.modifier,
          r.gramWeight,
          r.dataPoints,
          r.footnote,
          r.minYearAcquired,
        ],
      }
    : undefined;

  return streamCsvFile(
    filePath,
    (record) =>
      convertEmptyToNull({
        id: parseInteger(record.id),
        fdcId: parseInteger(record.fdc_id),
        seqNum: record.seq_num,
        amount: parseNumber(record.amount),
        measureUnitId: parseInteger(record.measure_unit_id),
        portionDescription: record.portion_description,
        modifier: record.modifier,
        gramWeight: parseNumber(record.gram_weight),
        dataPoints: record.data_points,
        footnote: record.footnote,
        minYearAcquired: record.min_year_acquired,
      }),
    usdaFoodPortion,
    batchSize,
    { ...opts, rawPrepared: raw }
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
    } catch (error) {
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
    journal_mode: sqlite.pragma("journal_mode", { simple: true }) as string | number,
    synchronous: sqlite.pragma("synchronous", { simple: true }) as string | number,
    temp_store: sqlite.pragma("temp_store", { simple: true }) as string | number,
    cache_size: sqlite.pragma("cache_size", { simple: true }) as number,
    mmap_size: sqlite.pragma("mmap_size", { simple: true }) as number,
  };
  try { sqlite.pragma("journal_mode = WAL"); } catch {}
  try { sqlite.pragma("synchronous = NORMAL"); } catch {}
  try { sqlite.pragma("temp_store = MEMORY"); } catch {}
  try { sqlite.pragma("cache_size = -200000"); } catch {}
  try { sqlite.pragma("mmap_size = 268435456"); } catch {}
  return prev;
}

function restorePragmas(prev: PragmasSnapshot) {
  console.log("\n=== Restoring PRAGMAs ===");
  const toUpper = (v: any) => typeof v === 'string' ? v.toUpperCase() : v;
  try { sqlite.pragma(`journal_mode = ${toUpper(prev.journal_mode)}`); } catch {}
  try { sqlite.pragma(`synchronous = ${toUpper(prev.synchronous)}`); } catch {}
  try { sqlite.pragma(`temp_store = ${toUpper(prev.temp_store)}`); } catch {}
  try { sqlite.pragma(`cache_size = ${prev.cache_size}`); } catch {}
  try { sqlite.pragma(`mmap_size = ${prev.mmap_size}`); } catch {}
}

async function main() {
  const args = process.argv.slice(2);
  const shouldClear = args.includes("--clear");
  const enableSafePragmas = args.includes("--fast");
  const useRaw = args.includes("--raw");
  const batchArg = args.find((a) => a.startsWith("--batch="));
  const batchSize = batchArg ? Math.max(1, parseInt(batchArg.split("=")[1] || "", 10) || DEFAULT_BATCH_SIZE) : DEFAULT_BATCH_SIZE;

  console.log("Starting USDA data import...");
  console.log(`Data path: ${USDA_DATA_PATH}`);
  if (enableSafePragmas) console.log("Fast mode: applying safe SQLite PRAGMAs (WAL, NORMAL, MEMORY, cache, mmap)");
  console.log(`Batch size: ${batchSize}${useRaw ? ' | raw prepared statements' : ''}`);

  if (shouldClear) {
    clearTables();
  }

  const previousPragmas = enableSafePragmas ? applySafePragmas() : null;

  const startTime = Date.now();
  let totalStats: ImportStats = { processed: 0, inserted: 0, skipped: 0 };

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
      const stats = await fn(batchSize, { useRaw });
      console.log(
        `${name}: ${stats.inserted} inserted, ${stats.skipped} skipped`
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
