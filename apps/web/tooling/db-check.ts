import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";

import { renderDerivedDdl } from "../src/server/db/derived-ddl";
import * as schema from "../src/server/db/schema";
import { diffSchemaCatalogs, readSchemaCatalog } from "./db-catalog";
import { ensureDbExtensions } from "./db-extensions";
import { MIGRATIONS_FOLDER, migrateDatabase } from "./db-migrate";
import { derivedDdlHash, readDerivedLock } from "./db-derived-ddl";
import { toPushSchemaDatabase } from "./drizzle-kit-interop";
import { testServiceConfig } from "./test-service-config";

/**
 * `pnpm db:check`: the committed migrations are the only way a database gets
 * its schema, so prove they still equal the model.
 *
 * (a) `schema.ts` has no change drizzle-kit would generate a migration for,
 *     the derived DDL matches `drizzle/derived.lock`, and the journal is
 *     strictly ordered (drizzle's migrator skips an entry older than the last
 *     applied one).
 * (b) A database built by the migrations has the same catalog as one built by
 *     pushing `schema.ts` plus the derived DDL.
 */

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

async function checkGeneratedState(): Promise<string[]> {
  const problems: string[] = [];
  const journal: Journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
  );
  journal.entries.forEach((entry, index) => {
    const previous = journal.entries[index - 1];
    if (previous && entry.when <= previous.when)
      problems.push(
        `journal: ${entry.tag} (when ${entry.when}) is not newer than ${previous.tag} (when ${previous.when}); drizzle would skip it`,
      );
  });
  const last = journal.entries.at(-1);
  if (!last) return [...problems, "journal: no migrations"];

  const { generateDrizzleJson, generateMigration } =
    await import("drizzle-kit/api");
  const snapshotPath = join(
    MIGRATIONS_FOLDER,
    `meta/${String(last.idx).padStart(4, "0")}_snapshot.json`,
  );
  const previous = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const current = generateDrizzleJson(schema, previous.id, ["public"]);
  const pending = await generateMigration(previous, current);
  if (pending.length > 0)
    problems.push(
      `schema.ts has changes with no migration; run \`pnpm db:generate\`:\n${pending.join("\n")}`,
    );

  if (derivedDdlHash() !== readDerivedLock())
    problems.push(
      "derived DDL changed without a migration; run `pnpm db:generate`",
    );
  return problems;
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
  const pool = new Pool({ connectionString: url });
  try {
    await build(drizzle(pool));
  } finally {
    await pool.end();
  }
}

/** The reference database: `schema.ts` pushed, plus the derived DDL. */
async function buildFromModel(db: NodePgDatabase): Promise<void> {
  const { pushSchema } = await import("drizzle-kit/api");
  await ensureDbExtensions(db);
  const { apply } = await pushSchema(schema, toPushSchemaDatabase(db), [
    "public",
  ]);
  await apply();
  await db.execute(sql.raw(renderDerivedDdl()));
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

async function main(): Promise<number> {
  const { host, port } = testServiceConfig();
  const adminUrl =
    process.env.DB_CHECK_ADMIN_URL ??
    `postgresql://postgres:password@${host}:${port}/postgres`;
  const started = Date.now();
  const problems: string[] = [];
  for (const check of [
    checkGeneratedState,
    () => checkCatalogEquality(adminUrl),
  ]) {
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
