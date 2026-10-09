import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { fdcId } from "../../schemas";
import { usdaBarcodeKey } from "../shard";
import {
  isoPublicationDate,
  normalizeDataType,
  publishedGtinUpc,
} from "./assemble";
import { integer, number, readCsv, text, type CsvRow } from "./csv";

const BATCH = 20_000;

// Scratch tables for the joins. food_nutrient.csv is grouped by fdc_id but not
// sorted, and food.csv / branded_food.csv are unsorted, so the build joins
// through SQLite instead of merging CSV streams. The (fdc_id, id) keys keep
// each food's nutrients and portions in USDA row order, as the old D1 import
// read them.
const SCHEMA = `
CREATE TABLE food (
  fdc_id INTEGER PRIMARY KEY,
  data_type TEXT NOT NULL,
  description TEXT NOT NULL,
  publication_date TEXT
);
CREATE TABLE branded (
  fdc_id INTEGER PRIMARY KEY,
  barcode_key TEXT,
  gtin_upc TEXT,
  brand_owner TEXT,
  brand_name TEXT,
  branded_food_category TEXT,
  ingredients TEXT,
  serving_size REAL,
  serving_size_unit TEXT,
  household_serving_fulltext TEXT
);
CREATE TABLE legacy (fdc_id INTEGER PRIMARY KEY, ndb_number INTEGER);
CREATE TABLE nutrient (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  nutrient_nbr TEXT
);
CREATE TABLE superseded (
  fdc_id INTEGER PRIMARY KEY,
  current_fdc_id INTEGER NOT NULL
);
CREATE TABLE food_nutrient (
  fdc_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  nutrient_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (fdc_id, id)
) WITHOUT ROWID;
CREATE TABLE food_portion (
  fdc_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  amount REAL NOT NULL,
  modifier TEXT,
  gram_weight REAL NOT NULL,
  PRIMARY KEY (fdc_id, id)
) WITHOUT ROWID;
`;

type Value = string | number | null;

async function load<C extends string>(
  db: Database.Database,
  file: string,
  columns: readonly C[],
  insertSql: string,
  toValues: (row: CsvRow<C>) => Value[] | null,
): Promise<number> {
  const insert = db.prepare(insertSql);
  const flush = db.transaction((rows: Value[][]) => {
    for (const values of rows) insert.run(values);
  });
  let batch: Value[][] = [];
  let loaded = 0;
  for await (const row of readCsv(file, columns)) {
    const values = toValues(row);
    if (values === null) continue;
    batch.push(values);
    loaded++;
    if (batch.length >= BATCH) {
      flush(batch);
      batch = [];
    }
  }
  flush(batch);
  return loaded;
}

/**
 * Load the FDC CSVs a `FoodSummary` needs into a scratch SQLite file and mark
 * superseded branded revisions: per barcode key, the latest publication_date
 * (then the highest fdc_id) is current. Rows the old importer dropped (no
 * fdc_id, no nutrient amount, no portion amount or gram weight) are dropped.
 */
export async function stageRelease(
  csvDir: string,
  scratchFile: string,
  log: (message: string) => void,
): Promise<Database.Database> {
  const db = new Database(scratchFile);
  db.pragma("journal_mode = OFF");
  db.pragma("synchronous = OFF");
  db.pragma("cache_size = -262144");
  db.exec(SCHEMA);
  const csv = (name: string) => path.join(csvDir, name);
  const step = async (name: string, run: () => Promise<number>) => {
    const started = Date.now();
    const count = await run();
    log(
      `${name}: ${count} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  };

  await step("nutrient.csv", () =>
    load(
      db,
      csv("nutrient.csv"),
      ["id", "name", "unit_name", "nutrient_nbr"],
      "INSERT OR IGNORE INTO nutrient VALUES (?, ?, ?, ?)",
      (row) => {
        const id = integer(row("id"));
        return id === null
          ? null
          : [id, row("name"), row("unit_name"), text(row("nutrient_nbr"))];
      },
    ),
  );

  await step("food.csv", () =>
    load(
      db,
      csv("food.csv"),
      ["fdc_id", "data_type", "description", "publication_date"],
      "INSERT OR IGNORE INTO food VALUES (?, ?, ?, ?)",
      (row) => {
        const fdcId = integer(row("fdc_id"));
        if (fdcId === null) return null;
        return [
          fdcId,
          normalizeDataType(row("data_type")),
          row("description") || "<empty>",
          isoPublicationDate(row("publication_date"), fdcId),
        ];
      },
    ),
  );

  await step("branded_food.csv", () =>
    load(
      db,
      csv("branded_food.csv"),
      [
        "fdc_id",
        "gtin_upc",
        "brand_owner",
        "brand_name",
        "branded_food_category",
        "ingredients",
        "serving_size",
        "serving_size_unit",
        "household_serving_fulltext",
      ],
      "INSERT OR IGNORE INTO branded VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      (row) => {
        const fdcId = integer(row("fdc_id"));
        if (fdcId === null) return null;
        const gtin = row("gtin_upc");
        return [
          fdcId,
          usdaBarcodeKey(gtin),
          publishedGtinUpc(gtin),
          text(row("brand_owner")),
          text(row("brand_name")),
          text(row("branded_food_category")),
          text(row("ingredients")),
          number(row("serving_size")),
          text(row("serving_size_unit")),
          text(row("household_serving_fulltext")),
        ];
      },
    ),
  );

  await step("sr_legacy_food.csv", () =>
    load(
      db,
      csv("sr_legacy_food.csv"),
      ["fdc_id", "NDB_number"],
      "INSERT OR IGNORE INTO legacy VALUES (?, ?)",
      (row) => {
        const fdcId = integer(row("fdc_id"));
        return fdcId === null ? null : [fdcId, integer(row("NDB_number"))];
      },
    ),
  );

  db.exec(`
    INSERT INTO superseded (fdc_id, current_fdc_id)
    SELECT fdc_id, current_fdc_id FROM (
      SELECT f.fdc_id,
        first_value(f.fdc_id) OVER (
          PARTITION BY b.barcode_key
          ORDER BY f.publication_date DESC, f.fdc_id DESC
        ) AS current_fdc_id
      FROM food f JOIN branded b ON b.fdc_id = f.fdc_id
      WHERE f.data_type = 'branded_food' AND b.barcode_key IS NOT NULL
    ) WHERE fdc_id <> current_fdc_id;
    CREATE INDEX superseded_current ON superseded (current_fdc_id, fdc_id);
  `);

  // Superseded revisions are never emitted, so their nutrients are not kept.
  const superseded = new Set(
    z
      .array(fdcId)
      .parse(db.prepare("SELECT fdc_id FROM superseded").pluck().all()),
  );
  log(`superseded branded revisions: ${superseded.size}`);

  await step("food_nutrient.csv", () =>
    load(
      db,
      csv("food_nutrient.csv"),
      ["id", "fdc_id", "nutrient_id", "amount"],
      "INSERT OR IGNORE INTO food_nutrient VALUES (?, ?, ?, ?)",
      (row) => {
        const fdcId = integer(row("fdc_id"));
        const id = integer(row("id"));
        const nutrientId = integer(row("nutrient_id"));
        const amount = number(row("amount"));
        if (fdcId === null || id === null || nutrientId === null) return null;
        if (amount === null || superseded.has(fdcId)) return null;
        return [fdcId, id, nutrientId, amount];
      },
    ),
  );

  await step("food_portion.csv", () =>
    load(
      db,
      csv("food_portion.csv"),
      ["id", "fdc_id", "amount", "modifier", "gram_weight"],
      "INSERT OR IGNORE INTO food_portion VALUES (?, ?, ?, ?, ?)",
      (row) => {
        const fdcId = integer(row("fdc_id"));
        const id = integer(row("id"));
        const amount = number(row("amount"));
        const gramWeight = number(row("gram_weight"));
        if (fdcId === null || id === null) return null;
        if (amount === null || gramWeight === null) return null;
        return [fdcId, id, amount, text(row("modifier")), gramWeight];
      },
    ),
  );

  return db;
}
