import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../src/env";
import { USDAClient } from "../src/server/clients/usda";
import type { Database } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { rebuildProductConversionCoverageProjection } from "../src/server/services/problems.service";

/**
 * Rebuild the versioned catalog conversion projection.
 *
 * Usage: pnpm --filter @cubby/web db:backfill-product-conversion-coverage
 *
 * This intentionally uses the ordinary USDA client and the same shared
 * mapping/WASM path as Problems. Run after the additive schema migration, not
 * as part of application startup or a request.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
const database = drizzle({ client: pool, schema }) as unknown as Database;

try {
  const rows = await rebuildProductConversionCoverageProjection(
    database,
    new USDAClient(env.USDA_API_URL),
  );
  console.log("ProductConversionCoverage backfill", {
    projected: rows.length,
    partial: rows.filter((row) => row.coverageTier === "partial").length,
    islanded: rows.filter((row) => row.islandCount >= 2).length,
    unavailable: rows.filter((row) => row.status === "unavailable").length,
  });
} finally {
  await pool.end();
}
