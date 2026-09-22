import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { ensureDbExtensions } from "./db-extensions";
import { assertDevDatabaseUrl } from "./dev-db-guard";
import { toPushSchemaDatabase } from "./drizzle-kit-interop";

/** Push the application schema to the local dev database (drizzle-kit push, same as `db:push`). */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assertDevDatabaseUrl(databaseUrl);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = drizzle(pool);
    console.log("[dev-db] Pushing schema...");
    const schema = await import("../src/server/db/schema");
    await ensureDbExtensions(db);
    const { pushSchema } = await import("drizzle-kit/api");
    const { apply } = await pushSchema(schema, toPushSchemaDatabase(db), [
      "public",
    ]);
    await apply();
    console.log("[dev-db] Schema pushed");
  } finally {
    await pool.end();
  }
}

await main();
