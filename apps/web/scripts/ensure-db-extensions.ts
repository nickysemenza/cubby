import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { ensureDbExtensions } from "../tooling/db-extensions";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required to ensure database extensions.");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle(pool);

try {
  await ensureDbExtensions(db);
  console.log("Database extensions ready: pg_trgm, vector");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Could not create required database extensions: ${message}`);
  console.error(
    "Make sure the target Postgres instance supports pgvector. For local dev, recreate the db container with pgvector/pgvector:pg17.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
