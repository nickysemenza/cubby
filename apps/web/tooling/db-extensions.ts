import { type SQL, sql } from "drizzle-orm";

interface ExtensionExecutor {
  execute(query: SQL): Promise<object>;
}

export async function ensureDbExtensions(db: ExtensionExecutor): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
}
