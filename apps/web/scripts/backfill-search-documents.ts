import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Database } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import {
  backfillSearchDocuments,
  getSearchDocumentDiagnostics,
} from "../src/server/repo/search-document";

const limitArg = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
  throw new Error("--limit must be a positive integer");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
const database = drizzle({ client: pool, schema }) as unknown as Database;

try {
  const before = await getSearchDocumentDiagnostics(database);
  console.log("SearchDocument diagnostics before backfill", {
    missing: before.missing.length,
    orphaned: before.orphaned.length,
    stale: before.stale.length,
  });

  const results = await backfillSearchDocuments(database, { limit });
  console.log("SearchDocument backfill", {
    processed: results.length,
    upserted: results.filter((result) => result.status === "upserted").length,
    missing: results.filter((result) => result.status === "missing").length,
  });

  if (limit == null) {
    const after = await getSearchDocumentDiagnostics(database);
    console.log("SearchDocument diagnostics after backfill", {
      missing: after.missing.length,
      orphaned: after.orphaned.length,
      stale: after.stale.length,
    });
    if (
      after.missing.length > 0 ||
      after.orphaned.length > 0 ||
      after.stale.length > 0
    ) {
      throw new Error("SearchDocument coverage is not clean after backfill");
    }
  }
} finally {
  await pool.end();
}
