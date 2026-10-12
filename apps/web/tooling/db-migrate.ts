import { createPostgresPool } from "./postgres-pool";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { sql } from "drizzle-orm";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";

import { z } from "zod";

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
export async function assertMigrationBookkeeping(
  db: NodePgDatabase,
  journal: readonly MigrationMeta[],
): Promise<number> {
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
    if ((rows[0]?.count ?? 0) === 0) return 0;
    throw new Error(
      "Refusing to migrate: public has tables but drizzle.__drizzle_migrations records no migrations " +
        "(a push-built database). Rebuild it with `pnpm dev reset`.",
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
  return applied.length;
}

/** Advance through an inclusive journal boundary; omitted means every pending migration. */
export async function migrateDatabase(
  db: NodePgDatabase,
  options: { migrationsFolder?: string; through?: string } = {},
): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  const journal = readMigrationFiles({ migrationsFolder });
  const { entries } = z
    .object({
      entries: z.array(
        z.object({
          idx: z.number().int().nonnegative(),
          when: z.number().int(),
          tag: z.string().min(1),
        }),
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"),
      ),
    );
  const tags = new Set<string>();
  entries.forEach((entry, index) => {
    const previous = entries[index - 1];
    if (
      entry.idx !== index ||
      tags.has(entry.tag) ||
      (previous && entry.when <= previous.when)
    )
      throw new Error(
        `Refusing to migrate: journal entry ${entry.tag} must have contiguous indexes, unique tags and strictly increasing timestamps.`,
      );
    tags.add(entry.tag);
  });
  const boundary =
    options.through === undefined
      ? journal.length - 1
      : entries.findIndex((entry) => entry.tag === options.through);
  if (options.through !== undefined && boundary < 0)
    throw new Error(
      `Refusing to migrate: --through=${options.through} is not an exact migration tag in the journal.`,
    );
  const appliedCount = await assertMigrationBookkeeping(db, journal);
  if (appliedCount > boundary + 1)
    throw new Error(
      `Refusing to migrate: database is already beyond --through=${options.through}; last applied migration is ${entries[appliedCount - 1]?.tag}. No migrations were applied.`,
    );
  await ensureDbExtensions(db);
  // Reuse Drizzle's transaction and bookkeeping engine with only the allowed prefix.
  // SAFETY: PgDialect implements this same NodePgSession at runtime; its
  // default PgQueryResultHKT signature loses the concrete driver variance.
  const session = db._.session as Parameters<PgDialect["migrate"]>[1];
  await new PgDialect().migrate(journal.slice(0, boundary + 1), session, {
    migrationsFolder,
  });
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
    "Usage: db-migrate.ts --target=dev|production [--through=exact-journal-tag] (production also needs PRODUCTION_DIRECT_DATABASE_URL)",
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { target: { type: "string" }, through: { type: "string" } },
  });
  const pool = createPostgresPool({
    connectionString: resolveTargetUrl(values.target),
  });
  try {
    await migrateDatabase(drizzle(pool), { through: values.through });
    console.log(
      `[db-migrate] ${values.target} database is current${values.through === undefined ? "" : ` through ${values.through}`}`,
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.main) await main();
