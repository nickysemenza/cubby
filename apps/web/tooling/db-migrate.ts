import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { ensureDbExtensions } from "./db-extensions";
import { assertDevDatabaseUrl } from "./dev/state";

/** The committed, ordered migration series (`apps/web/drizzle`). */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

/**
 * Drizzle's migrator applies every journal entry newer than the LAST
 * bookkeeping row's `created_at` and never compares hashes. A database whose
 * rows are not exactly a prefix of this journal (legacy rows from another
 * era, an edited migration, a push-built schema with no rows) would have
 * migrations re-applied or silently skipped, so refuse it instead.
 */
async function assertMigrationBookkeeping(db: NodePgDatabase): Promise<void> {
  const journal = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const { rows: bookkeeping } = await db.execute<{ exists: boolean }>(
    sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`,
  );
  const applied = bookkeeping[0]?.exists
    ? (
        await db.execute<{ hash: string; created_at: string }>(
          sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id`,
        )
      ).rows
    : [];
  if (applied.length === 0) {
    const { rows } = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
    if ((rows[0]?.count ?? 0) === 0) return;
    throw new Error(
      "Refusing to migrate: public has tables but drizzle.__drizzle_migrations records no migrations " +
        "(a push-built database). Rebuild it with `pnpm db:dev:reset`.",
    );
  }
  applied.forEach((row, index) => {
    const expected = journal[index];
    if (
      !expected ||
      Number(row.created_at) !== expected.folderMillis ||
      row.hash !== expected.hash
    )
      throw new Error(
        `Refusing to migrate: bookkeeping row ${index + 1} (created_at ${row.created_at}) does not match ` +
          `journal entry ${index} (${expected ? `when ${expected.folderMillis}` : "none"}); ` +
          "committed migrations are immutable and the bookkeeping must be a prefix of the journal.",
      );
  });
}

/** Build or advance a database: extensions, then every pending migration. */
export async function migrateDatabase(db: NodePgDatabase): Promise<void> {
  await assertMigrationBookkeeping(db);
  await ensureDbExtensions(db);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

const PRODUCTION_URL_ENV = "PRODUCTION_DIRECT_DATABASE_URL";

/**
 * `--target=dev` (via `pnpm db:dev:migrate`): only the guarded local
 * container. `--target=production`: only an explicit direct (non-pooled) URL
 * in PRODUCTION_DIRECT_DATABASE_URL — never the ambient DATABASE_URL, which
 * can still point at production in legacy environments.
 */
function resolveTargetUrl(target: string | undefined): string {
  if (target === "dev") {
    const url = process.env.DATABASE_URL ?? "";
    assertDevDatabaseUrl(url);
    return url;
  }
  if (target === "production") {
    const url = process.env[PRODUCTION_URL_ENV];
    if (!url)
      throw new Error(
        `--target=production needs ${PRODUCTION_URL_ENV} set to the direct (non-pooled) production URL.`,
      );
    if (new URL(url).hostname.includes("-pooler"))
      throw new Error(
        `${PRODUCTION_URL_ENV} is a pooled endpoint; migrations need the direct host.`,
      );
    return url;
  }
  throw new Error(
    "Usage: db-migrate.ts --target=dev|production (production also needs PRODUCTION_DIRECT_DATABASE_URL)",
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { target: { type: "string" } } });
  const pool = new Pool({ connectionString: resolveTargetUrl(values.target) });
  try {
    await migrateDatabase(drizzle(pool));
    console.log(`[db-migrate] ${values.target} database is current`);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) await main();
