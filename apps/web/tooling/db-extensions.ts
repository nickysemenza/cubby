import { type SQL, sql } from "drizzle-orm";

interface ExtensionExecutor {
  execute(query: SQL): Promise<unknown>;
}

export async function ensureDbExtensions(db: ExtensionExecutor): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
}
