import { createPostgresPool } from "./postgres-pool";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { renderDeclaredDerivedViews } from "../src/server/workflows/derived-views";
import { renderDerivedDdl } from "../src/server/db/derived-ddl";
import { drizzleSchema as schema } from "../src/server/db/drizzle-schema";
import { diffSchemaCatalogs, readSchemaCatalog } from "./db-catalog";
import { ensureDbExtensions } from "./db-extensions";
import { MIGRATIONS_FOLDER, migrateDatabase } from "./db-migrate";
import { testServiceConfig } from "./test-service-config";

/**
 * `pnpm db:check`: the committed migrations are the only way a database gets
 * its schema, so prove they still equal the model.
 *
 * (a) `schema.ts` has no change drizzle-kit would generate a migration for,
 *     and v1 snapshots reconstruct the current schema.
 * (b) A database built by the migrations has the same catalog as one built by
 *     pushing `schema.ts` plus the derived DDL.
 *
 * `pnpm db:check --against-production` instead diffs a migrations-built
 * database against `PRODUCTION_DIRECT_DATABASE_URL` (read through a read-only
 * session) — the post-cutover proof that production equals a fresh build.
 */

async function checkGeneratedState(): Promise<string[]> {
  const { generateDrizzleJson, generateMigration, reconstruct } =
    await import("drizzle-kit/api-postgres");
  const snapshots = Object.fromEntries(
    readdirSync(MIGRATIONS_FOLDER).flatMap((name) => {
      const file = join(MIGRATIONS_FOLDER, name, "snapshot.json");
      return existsSync(file)
        ? [[name, JSON.parse(readFileSync(file, "utf8"))]]
        : [];
    }),
  );
  const previous = await reconstruct(snapshots);
  const current = await generateDrizzleJson(schema, previous.id, ["public"]);
  const pending = await generateMigration(previous, current);
  return pending.length === 0
    ? []
    : [
        `schema.ts has changes with no migration; run \`pnpm db:generate\`:\n${pending.join("\n")}`,
      ];
}

async function withScratchDatabase<T>(
  adminUrl: string,
  label: string,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const name = `cubby_db_check_${label}_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    try {
      return await run(url.toString());
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}

async function withDb(
  url: string,
  build: (db: NodePgDatabase) => Promise<void>,
): Promise<void> {
  const pool = createPostgresPool({ connectionString: url });
  try {
    await build(drizzle({ client: pool, paramsInErrors: true }));
  } finally {
    await pool.end();
  }
}

/** The reference database: `schema.ts` pushed, plus the derived DDL. */
async function buildFromModel(db: NodePgDatabase): Promise<void> {
  const { pushSchema } = await import("drizzle-kit/api-postgres");
  await ensureDbExtensions(db);
  const { apply } = await pushSchema(schema, db, {
    schemas: ["public"],
    tables: [],
    entities: undefined,
    extensions: [],
  });
  await apply();
  await db.execute(sql.raw(renderDerivedDdl()));
  await db.execute(sql.raw(renderDeclaredDerivedViews()));
}

async function checkCatalogEquality(adminUrl: string): Promise<string[]> {
  return withScratchDatabase(adminUrl, "model", (modelUrl) =>
    withScratchDatabase(adminUrl, "migrations", async (migrationsUrl) => {
      await withDb(modelUrl, buildFromModel);
      await withDb(migrationsUrl, migrateDatabase);
      return diffSchemaCatalogs(
        await readSchemaCatalog(modelUrl),
        await readSchemaCatalog(migrationsUrl),
        { expected: "schema.ts", actual: "migrations" },
      );
    }),
  );
}

async function checkAgainstProduction(adminUrl: string): Promise<string[]> {
  const productionUrl = process.env.PRODUCTION_DIRECT_DATABASE_URL;
  if (!productionUrl)
    return ["--against-production needs PRODUCTION_DIRECT_DATABASE_URL"];
  return withScratchDatabase(adminUrl, "migrations", async (migrationsUrl) => {
    await withDb(migrationsUrl, migrateDatabase);
    return diffSchemaCatalogs(
      await readSchemaCatalog(migrationsUrl),
      await readSchemaCatalog(productionUrl),
      { expected: "migrations", actual: "production" },
    );
  });
}

async function main(): Promise<number> {
  const { host, port } = testServiceConfig();
  const adminUrl =
    process.env.DB_CHECK_ADMIN_URL ??
    `postgresql://postgres:password@${host}:${port}/postgres`;
  const started = Date.now();
  const problems: string[] = [];
  const checks = process.argv.includes("--against-production")
    ? [() => checkAgainstProduction(adminUrl)]
    : [checkGeneratedState, () => checkCatalogEquality(adminUrl)];
  for (const check of checks) {
    const found = await check();
    for (const problem of found) console.error(`[db:check] ${problem}`);
    problems.push(...found);
  }
  console.log(
    `[db:check] ${problems.length === 0 ? "ok" : `${problems.length} problem(s)`} in ${Date.now() - started}ms`,
  );
  return problems.length === 0 ? 0 : 1;
}

process.exitCode = await main();
