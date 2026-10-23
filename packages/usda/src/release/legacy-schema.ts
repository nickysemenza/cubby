import { z } from "zod";
import type { ReleaseSql } from "./store";

// Frozen pre-Drizzle catalog: only used before baseline adoption. Future
// migrations must not update this contract or validate it on every restart.
const LEGACY_TABLES = [
  `CREATE TABLE IF NOT EXISTS release_state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     release TEXT NOT NULL,
     state TEXT NOT NULL,
     manifest TEXT,
     next_shard INTEGER NOT NULL DEFAULT 0,
     attempts INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     started_at TEXT NOT NULL,
     ready_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS food (
     fdc_id INTEGER PRIMARY KEY,
     data_type TEXT NOT NULL,
     description TEXT NOT NULL,
     barcode_key TEXT,
     ndb_number INTEGER,
     summary TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS food_barcode_key ON food (barcode_key)",
  "CREATE INDEX IF NOT EXISTS food_ndb_number ON food (ndb_number)",
  "CREATE INDEX IF NOT EXISTS food_description ON food (description)",
  "CREATE INDEX IF NOT EXISTS food_data_type ON food (data_type, description)",
  `CREATE TABLE IF NOT EXISTS food_alias (
     fdc_id INTEGER PRIMARY KEY,
     current_fdc_id INTEGER NOT NULL
   ) WITHOUT ROWID`,
];

// Contentless: the text lives in `food`; this table only maps terms to
// rowid = fdc_id. Brand columns weigh less than the description. The rank
// setting persists in the FTS shadow tables across adoption.
const LEGACY_SEARCH = `CREATE VIRTUAL TABLE food_search USING fts5(
     description, brand_name, brand_owner,
     content = '', tokenize = 'unicode61 remove_diacritics 1'
   )`;

export function assertLegacyReleaseSchema(
  sql: ReleaseSql,
  baselineTimestamp: number,
) {
  const ledger = sql
    .exec("SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'")
    .toArray();
  if (
    ledger.length &&
    sql
      .exec(
        "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
        baselineTimestamp,
      )
      .toArray().length
  )
    return;
  // Catalog DDL validates constraints, indexes, WITHOUT ROWID and FTS options;
  // ordinary typed selects cannot distinguish these incompatible shapes.
  const normalize = (statement: string) =>
    statement
      .toLowerCase()
      .replace(/if\s+not\s+exists/gu, "")
      .replace(/[\s;`"[\]]/gu, "");
  const definitions = [...LEGACY_TABLES, LEGACY_SEARCH];
  for (const definition of definitions) {
    const name = /(?:TABLE|INDEX) (?:IF NOT EXISTS )?(\w+)/u.exec(
      definition,
    )?.[1];
    if (!name) throw new Error("Invalid legacy USDA schema definition");
    const existing = sql
      .exec("SELECT sql FROM sqlite_master WHERE name = ?", name)
      .toArray()[0];
    if (!existing) continue;
    const statement = z
      .object({ sql: z.string().nullable() })
      .parse(existing).sql;
    if (statement === null || normalize(statement) !== normalize(definition))
      throw new Error(`Incompatible legacy USDA release schema: ${name}`);
  }
  const search = sql
    .exec("SELECT name FROM sqlite_master WHERE name = 'food_search'")
    .toArray();
  const foods = sql
    .exec("SELECT name FROM sqlite_master WHERE name = 'food'")
    .toArray();
  if (
    !search.length &&
    foods.length &&
    sql.exec("SELECT 1 FROM food LIMIT 1").toArray().length
  )
    throw new Error(
      "Incompatible legacy USDA release schema: populated food without food_search",
    );
}
