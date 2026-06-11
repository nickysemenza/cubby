import BetterSqlite3 from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH =
  process.env.DATABASE_PATH || path.resolve("data", "usda.sqlite");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const createDatabase = (
  path: string,
  readonly: boolean = false,
): BetterSqlite3Database => {
  const db = new BetterSqlite3(path, { readonly });

  // Apply performance-optimized pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("cache_size = -64000"); // 64MB cache per connection
  db.pragma("temp_store = MEMORY"); // Use memory for temp storage
  db.pragma("mmap_size = 268435456"); // 256MB memory-mapped I/O
  db.pragma("synchronous = NORMAL"); // Safe for read-heavy workloads
  db.pragma("foreign_keys = ON"); // Maintain referential integrity

  return db;
};

export const sqlite = createDatabase(DB_PATH);
export const db = drizzle(sqlite, { logger: false });
