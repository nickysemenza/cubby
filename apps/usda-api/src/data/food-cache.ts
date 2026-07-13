import type { FoodSummary } from "@cubby/usda-schemas";
import type { D1Database } from "@cloudflare/workers-types";

const MAX_SQL_VARIABLES = 100;
const FOOD_CACHE_TABLE = "food_cache";
let foodCacheEnsured = false;

async function ensureFoodCacheTable(db: D1Database): Promise<void> {
  if (foodCacheEnsured) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${FOOD_CACHE_TABLE} (
         version TEXT NOT NULL,
         fdc_id INTEGER NOT NULL,
         data TEXT NOT NULL,
         PRIMARY KEY (version, fdc_id)
       )`,
    )
    .run();
  foodCacheEnsured = true;
}

export async function readFoodCache(
  db: D1Database,
  version: string,
  fdcIds: number[],
): Promise<Map<number, FoodSummary>> {
  const out = new Map<number, FoodSummary>();
  if (fdcIds.length === 0) return out;
  try {
    await ensureFoodCacheTable(db);
  } catch (error) {
    console.warn(
      "[food-cache] table setup failed; continuing without cache",
      error,
    );
    return out;
  }
  for (let index = 0; index < fdcIds.length; index += MAX_SQL_VARIABLES - 1) {
    const chunk = fdcIds.slice(index, index + MAX_SQL_VARIABLES - 1);
    const placeholders = chunk.map(() => "?").join(", ");
    try {
      const result = await db
        .prepare(
          `SELECT fdc_id, data FROM ${FOOD_CACHE_TABLE} WHERE version = ? AND fdc_id IN (${placeholders})`,
        )
        .bind(version, ...chunk)
        .all<{ fdc_id: number; data: string }>();
      for (const row of result.results ?? []) {
        try {
          out.set(row.fdc_id, JSON.parse(row.data) as FoodSummary);
        } catch (error) {
          console.warn(
            `[food-cache] ignoring unparseable cached food ${row.fdc_id}`,
            error,
          );
        }
      }
    } catch (error) {
      console.warn("[food-cache] read failed; treating cache as a miss", error);
    }
  }
  return out;
}

export async function writeFoodCache(
  db: D1Database,
  version: string,
  foods: FoodSummary[],
): Promise<void> {
  if (foods.length === 0) return;
  try {
    await ensureFoodCacheTable(db);
    await db.batch(
      foods.map((food) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO ${FOOD_CACHE_TABLE} (version, fdc_id, data) VALUES (?, ?, ?)`,
          )
          .bind(version, food.fdc_id, JSON.stringify(food)),
      ),
    );
  } catch (error) {
    console.warn("[food-cache] write failed; continuing without cache", error);
  }
}
