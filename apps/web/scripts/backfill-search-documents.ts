import { searchableEntities } from "@cubby/schemas/search";
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Database } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import {
  backfillSearchDocuments,
  getSearchDocumentDiagnostics,
} from "../src/server/repo/search-document";

/**
 * Re-project SearchDocument from its sources.
 *
 * Usage:
 *   pnpm --filter @cubby/web db:backfill-search-documents
 *   pnpm --filter @cubby/web db:backfill-search-documents -- --types=location,inventory
 *   pnpm --filter @cubby/web db:backfill-search-documents -- --limit=500
 *
 * `--types` is the reason this is a script and not only the Problems repair
 * button: when a projection or an enum changes, every document of one entity
 * is stale at once and no mutation will ever touch them. Scoping the rewrite
 * keeps the other ~27k rows' `updatedAt` — the embedding backfill's scan order
 * — untouched.
 */
const argument = (name: string): string | undefined =>
  process.argv
    .slice(2)
    .find((value) => value.startsWith(`--${name}=`))
    ?.split("=")[1];

const limitArg = argument("limit");
const limit = limitArg ? Number(limitArg) : undefined;
if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
  throw new Error("--limit must be a positive integer");
}

const typesArg = argument("types");
const entityTypes = typesArg
  ? typesArg.split(",").map((value) => {
      const entityType = value.trim();
      if (!(searchableEntities as readonly string[]).includes(entityType)) {
        throw new Error(
          `--types got "${entityType}"; expected one of ${searchableEntities.join(", ")}`,
        );
      }
      return entityType as (typeof searchableEntities)[number];
    })
  : undefined;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
const database = drizzle({ client: pool, schema }) as unknown as Database;

try {
  const before = await getSearchDocumentDiagnostics(database, entityTypes);
  console.log("SearchDocument diagnostics before backfill", {
    missing: before.missing.length,
    orphaned: before.orphaned.length,
    stale: before.stale.length,
  });

  const results = await backfillSearchDocuments(database, {
    limit,
    entityTypes,
  });
  console.log("SearchDocument backfill", {
    processed: results.length,
    upserted: results.filter((result) => result.status === "upserted").length,
    missing: results.filter((result) => result.status === "missing").length,
  });

  if (limit == null) {
    const after = await getSearchDocumentDiagnostics(database, entityTypes);
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
