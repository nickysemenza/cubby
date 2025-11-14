import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { count } from 'drizzle-orm';
import { instrumentDrizzleClient } from '@kubiks/otel-drizzle';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema';

const DB_PATH =
  process.env.DATABASE_PATH || path.resolve('data', 'usda.sqlite');

// Ensure folder exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// If DB file does not exist and a baked-in copy exists in the image, seed it.
try {
  if (!fs.existsSync(DB_PATH)) {
    const candidates = [
      path.resolve('/app/data/usda.sqlite'),
      path.resolve(process.cwd(), 'data/usda.sqlite'),
    ];
    const seedPath = candidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (seedPath && path.resolve(seedPath) !== path.resolve(DB_PATH)) {
      fs.copyFileSync(seedPath, DB_PATH);
      // Clean up any leftover journal files at target path
      for (const suffix of ['-wal', '-shm']) {
        try {
          fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
        } catch {
          // Ignore file removal errors - file may not exist
        }
      }
      // Match permissions to ensure readable by app user
      try {
        fs.chmodSync(DB_PATH, 0o644);
      } catch {
        // Ignore permission errors - not critical
      }
      console.log(`Seeded database from ${seedPath} -> ${DB_PATH}`);
    }
  }
} catch (e) {
  console.warn('Database seed check failed:', e);
}

// Create a function to configure database connections
const createDatabase = (
  path: string,
  readonly: boolean = false
): BetterSqlite3Database => {
  const db = new BetterSqlite3(path, { readonly });

  // Apply performance-optimized pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('cache_size = -64000'); // 64MB cache per connection
  db.pragma('temp_store = MEMORY'); // Use memory for temp storage
  db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
  db.pragma('synchronous = NORMAL'); // Safe for read-heavy workloads
  db.pragma('foreign_keys = ON'); // Maintain referential integrity

  return db;
};

// Main connection - readonly in production since we never write
const isProduction = process.env.NODE_ENV === 'production';
export const sqlite = createDatabase(DB_PATH, isProduction);

// Connection pool for read-only queries (better concurrency)
const READ_POOL_SIZE = 4;
const readConnections: BetterSqlite3Database[] = [];
let connectionIndex = 0;

for (let i = 0; i < READ_POOL_SIZE; i++) {
  readConnections.push(createDatabase(DB_PATH, true));
}

// Get next read connection in round-robin fashion
export const getReadConnection = (): BetterSqlite3Database => {
  const connection = readConnections[connectionIndex];
  connectionIndex = (connectionIndex + 1) % READ_POOL_SIZE;
  return connection;
};

// Close all connections gracefully
export const closeAllConnections = () => {
  sqlite.close();
  readConnections.forEach((conn) => conn.close());
};

// Disable logger in production for better performance
// const isDevelopment = process.env.NODE_ENV !== "production";

export const db = instrumentDrizzleClient(drizzle(sqlite, { logger: false }), {
  dbSystem: 'sqlite',
  dbName: 'usda',
});

export const countUsdaFood = async () => {
  const rows = await db
    .select({ count: count() })
    .from(schema.usdaFood)
    .limit(1)
    .prepare()
    .execute();
  return rows[0]?.count ?? 0;
};

export const countUsdaBrandedFood = async () => {
  const rows = await db
    .select({ count: count() })
    .from(schema.usdaBrandedFood)
    .limit(1)
    .prepare()
    .execute();
  return rows[0]?.count ?? 0;
};

export const countUsdaNutrient = async () => {
  const rows = await db
    .select({ count: count() })
    .from(schema.usdaNutrient)
    .limit(1)
    .prepare()
    .execute();
  return rows[0]?.count ?? 0;
};

export const countUsdaFoodNutrient = async () => {
  const rows = await db
    .select({ count: count() })
    .from(schema.usdaFoodNutrient)
    .limit(1)
    .prepare()
    .execute();
  return rows[0]?.count ?? 0;
};

export const countUsdaMeasureUnit = async () => {
  const rows = await db
    .select({ count: count() })
    .from(schema.usdaMeasureUnit)
    .limit(1)
    .prepare()
    .execute();
  return rows[0]?.count ?? 0;
};

export const countUsdaFoodPortion = async () => {
  const rows = await db
    .select({ count: count() })
    .from(schema.usdaFoodPortion)
    .limit(1)
    .prepare()
    .execute();
  return rows[0]?.count ?? 0;
};

export const countUsdaSrLegacyFood = async () => {
  const rows = await db
    .select({ count: count() })
    .from(schema.usdaSrLegacyFood)
    .limit(1)
    .prepare()
    .execute();
  return rows[0]?.count ?? 0;
};
