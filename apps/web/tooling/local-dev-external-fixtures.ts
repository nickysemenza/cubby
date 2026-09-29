import { readFile } from "node:fs/promises";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { foodSummary } from "@cubby/usda";

const VERSION = "vlocal1";
export const LOCAL_FIXTURE_UPC = "012345678905";

/** Small synthetic data exercises the actual D1 index + R2 range-read path. */
export async function seedLocalUsda(env: {
  DB: D1Database;
  USDA_BUNDLES: R2Bucket;
}): Promise<void> {
  const foods = [
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
  ].map((fixture) =>
    foodSummary.parse({
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
  );
  await env.DB
    .exec(`CREATE TABLE IF NOT EXISTS usda_edge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS food_cache (version TEXT NOT NULL, fdc_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(version,fdc_id));
    CREATE TABLE IF NOT EXISTS food_index_${VERSION} (fdc_id INTEGER PRIMARY KEY, data_type TEXT NOT NULL, description TEXT NOT NULL, short_description TEXT, brand_name TEXT, brand_owner TEXT, gtin_upc TEXT, ndb_number INTEGER, bundle_key TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS food_search_${VERSION} USING fts5(fdc_id UNINDEXED, data_type UNINDEXED, description, tokenize='unicode61 remove_diacritics 1');
    DELETE FROM food_search_${VERSION}; DELETE FROM food_index_${VERSION}; DELETE FROM food_cache;`);
  const key = `usda/${VERSION}/bundles/food-000000.ndjson`;
  let offset = 0;
  const lines: string[] = [];
  const statements = [];
  for (const food of foods) {
    const line = JSON.stringify(food);
    const length = Buffer.byteLength(line);
    statements.push(
      env.DB.prepare(
        `INSERT INTO food_index_${VERSION} (fdc_id, data_type, description, bundle_key, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        food.fdc_id,
        food.foodInfo.data_type,
        food.foodInfo.description,
        key,
        offset,
        length,
      ),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO food_search_${VERSION} (fdc_id, data_type, description) VALUES (?, ?, ?)`,
      ).bind(food.fdc_id, food.foodInfo.data_type, food.foodInfo.description),
    );
    offset += length + 1;
    lines.push(line);
  }
  await env.USDA_BUNDLES.put(key, `${lines.join("\n")}\n`, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  await env.USDA_BUNDLES.put(
    `usda/${VERSION}/manifest.json`,
    JSON.stringify({
      counts: {
        usda_food: foods.length,
        usda_branded_food: 0,
        usda_nutrient: 4,
        usda_food_nutrient: foods.length * 4,
        usda_measure_unit: 0,
        usda_food_portion: 0,
        usda_sr_legacy_food: 0,
      },
    }),
  );
  statements.push(
    env.DB.prepare(
      "INSERT OR REPLACE INTO usda_edge_meta (key,value) VALUES ('active_version', ?)",
    ).bind(VERSION),
  );
  await env.DB.batch(statements);
}

export async function seedLocalUpc(env: {
  DB: D1Database;
  IMAGES: R2Bucket;
}): Promise<void> {
  await env.DB
    .exec(`CREATE TABLE IF NOT EXISTS products (upc TEXT PRIMARY KEY, name TEXT NOT NULL, manufacturer TEXT, brand TEXT, category TEXT, description TEXT, price_dollars REAL, image_key TEXT, source TEXT NOT NULL, source_data TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_manufacturer ON products(manufacturer);
    CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
    CREATE TABLE IF NOT EXISTS upc_misses (upc TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 1, last_checked_at TEXT DEFAULT (datetime('now')));`);
  const key = `images/${LOCAL_FIXTURE_UPC}.png`;
  const bytes = await readFile(
    new URL(
      "../tests/e2e/fixtures/synthetic-wardrobe-shirt.png",
      import.meta.url,
    ),
  );
  await env.IMAGES.put(key, bytes, {
    httpMetadata: { contentType: "image/png" },
  });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO products (upc,name,manufacturer,brand,category,description,price_dollars,image_key,source) VALUES (?, 'Synthetic cotton shirt', 'Synthetic Works', 'Synthetic', 'Clothing', 'Local synthetic barcode fixture', 18, ?, 'manual')`,
  )
    .bind(LOCAL_FIXTURE_UPC, key)
    .run();
}
