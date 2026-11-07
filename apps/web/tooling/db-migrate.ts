import { createPostgresPool } from "./postgres-pool";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { sql } from "drizzle-orm";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/pg-core/async";

import { z } from "zod";

import { ensureDbExtensions } from "./db-extensions";
import { assertDevDatabaseUrl } from "./dev/state";

/** The committed, ordered migration series (`apps/web/drizzle`). */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

/** Validate named history and SQL hashes before the migrator upgrades bookkeeping. */
export async function assertMigrationBookkeeping(
  db: NodePgDatabase,
  migrations: readonly MigrationMeta[],
  migrationsFolder?: string,
): Promise<string[]> {
  const { rows: bookkeeping } = await db.execute<{ exists: boolean }>(
    sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`,
  );
  // to_jsonb also reads legacy ledgers that do not have the name column yet.
  const applied = bookkeeping[0]?.exists
    ? (
        await db.execute<{
          hash: string;
          created_at: string;
          name: string | null;
          has_name: boolean;
        }>(
          // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- Ledger metadata key, not a household enum.
          sql`SELECT hash, created_at, to_jsonb(m)->>'name' AS name, to_jsonb(m) ? 'name' AS has_name
          FROM drizzle.__drizzle_migrations m ORDER BY created_at, id`,
        )
      ).rows
    : [];
  if (applied.length === 0) {
    const { rows } = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
    if ((rows[0]?.count ?? 0) === 0) return [];
    throw new Error(
      "Refusing to migrate: public has tables but drizzle.__drizzle_migrations records no migrations (a push-built database).",
    );
  }
  // A v1 ledger with an unnamed receipt would make the native migrator replay it.
  if (applied.some((row) => row.has_name && !row.name))
    throw new Error(
      "Refusing to migrate: a v1 bookkeeping row has no migration name.",
    );
  const baselinePath =
    migrationsFolder === undefined
      ? undefined
      : join(migrationsFolder, "baseline.json");
  if (
    baselinePath &&
    existsSync(baselinePath) &&
    applied[0]?.hash !== migrations[0]?.hash
  ) {
    const baseline = z
      .object({
        baselineHash: z.string(),
        retiredCount: z.number().int().positive(),
        retiredDigest: z.string(),
      })
      .parse(JSON.parse(readFileSync(baselinePath, "utf8")));
    const digest = createHash("sha256")
      .update(applied.map((row) => `${row.created_at}:${row.hash}\n`).join(""))
      .digest("hex");
    const first = migrations[0];
    if (
      first &&
      first.hash === baseline.baselineHash &&
      applied.length === baseline.retiredCount &&
      digest === baseline.retiredDigest
    ) {
      // Only the complete retired ledger can adopt the baseline, without replaying DDL.
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM drizzle.__drizzle_migrations`);
        await tx.execute(
          applied[0]?.has_name
            ? sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name, applied_at)
              VALUES (${first.hash}, ${first.folderMillis}, ${first.name}, NULL)`
            : sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
              VALUES (${first.hash}, ${first.folderMillis})`,
        );
      });
      return [first.name];
    }
  }
  const names = new Set<string>();
  for (const row of applied) {
    const expected = row.name
      ? migrations.find((entry) => entry.name === row.name)
      : migrations.find(
          (entry) =>
            entry.hash === row.hash &&
            entry.folderMillis ===
              Math.floor(Number(row.created_at) / 1000) * 1000,
        );
    if (!expected || expected.hash !== row.hash || names.has(expected.name))
      throw new Error(
        "Refusing to migrate: unknown, edited or duplicate applied migration; committed SQL and migration names are immutable.",
      );
    names.add(expected.name);
  }
  return [...names];
}

/** A lock wait that timed out, or a deadlock Postgres broke by aborting this statement. */
const LOCK_CONTENTION_CODES = new Set(["55P03", "40P01"]);
/** About two minutes against live writers, then the deployment stops, fail closed. */
const LOCK_RETRIES = 30;
/** A whole-transaction attempt is much heavier than one idempotent statement. */
const TRANSACTION_LOCK_RETRIES = 5;
const TRANSACTION_LOCK_RETRY_DELAY_MS = 15_000;

/**
 * Live queue traffic can hold or cross a cutover's locks (0037 deadlocked on every
 * attempt). A statement in this mode is idempotent and rolled back whole, so taking
 * it again from the start is safe. Whatever was already committed stays compatible
 * with the running Worker; a later Deploy resumes from the same statement.
 */
const isLockContention = (error: unknown) => {
  // Drizzle wraps the driver's error as its cause.
  for (let cause = error; cause instanceof Error; cause = cause.cause)
    if ("code" in cause && LOCK_CONTENTION_CODES.has(String(cause.code)))
      return true;
  return false;
};

export async function retryingLockContention<T>(
  statement: () => Promise<T>,
  { retries = LOCK_RETRIES, delayMs = 1_000 } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await statement();
    } catch (error) {
      if (attempt >= retries || !isLockContention(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Advance through an inclusive migration boundary; omitted means every pending migration. */
export async function migrateDatabase(
  db: NodePgDatabase,
  options: {
    migrationsFolder?: string;
    through?: string;
    /** The pause between whole-transaction attempts after lock contention. */
    lockRetryDelayMs?: number;
  } = {},
): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  const migrations = readMigrationFiles({ migrationsFolder });
  const boundary =
    options.through === undefined
      ? migrations.length - 1
      : migrations.findIndex((entry) => entry.name === options.through);
  if (options.through !== undefined && boundary < 0)
    throw new Error(
      `Refusing to migrate: --through=${options.through} is not an exact migration folder name.`,
    );
  const applied = new Set(
    await assertMigrationBookkeeping(db, migrations, migrationsFolder),
  );
  if (migrations.slice(boundary + 1).some((entry) => applied.has(entry.name)))
    throw new Error(
      `Refusing to migrate: database is already beyond --through=${options.through}. No migrations were applied.`,
    );
  await ensureDbExtensions(db);
  // SAFETY: the concrete node-postgres HKT is the engine's runtime database;
  // its generic query-result signature loses the concrete driver's variance.
  const migrationDb = db as Parameters<typeof migrate>[1];
  // Upgrade the complete applied ledger before limiting execution to the boundary.
  // Passing only applied files lets Drizzle backfill names without executing DDL.
  await migrate(
    migrations.filter((entry) => applied.has(entry.name)),
    migrationDb,
    { migrationsFolder },
  );
  const pending = migrations
    .slice(0, boundary + 1)
    .filter((entry) => !applied.has(entry.name));
  const retryTransaction = (batch: MigrationMeta[]) =>
    retryingLockContention(
      () => migrate(batch, migrationDb, { migrationsFolder }),
      {
        retries: TRANSACTION_LOCK_RETRIES,
        delayMs: options.lockRetryDelayMs ?? TRANSACTION_LOCK_RETRY_DELAY_MS,
      },
    );
  if (
    !pending.some((migration) =>
      migration.sql[0]?.includes("-- cubby:transaction-per-statement"),
    )
  ) {
    await retryTransaction(pending);
    return;
  }
  for (const migration of pending) {
    if (!migration.sql[0]?.includes("-- cubby:transaction-per-statement")) {
      await retryTransaction([migration]);
      continue;
    }
    // Opt-in backfills must be restartable: a crash leaves committed batches
    // but no migration receipt. Each statement therefore has to be idempotent.
    for (const statement of migration.sql) {
      if (statement.includes("-- cubby:outside-transaction")) {
        await db.execute(sql.raw(statement));
        continue;
      }
      let remaining: boolean;
      do {
        remaining = await retryingLockContention(() =>
          db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
            const result = await tx.execute<{ remaining: boolean }>(
              sql.raw(statement),
            );
            return statement.includes("-- cubby:repeat-batch")
              ? z.object({ remaining: z.boolean() }).parse(result.rows[0])
                  .remaining
              : false;
          }),
        );
      } while (remaining);
    }
    await db.execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name)
      VALUES (${migration.hash}, ${migration.folderMillis}, ${migration.name})`);
  }
}

const PRODUCTION_URL_ENV = "PRODUCTION_DIRECT_DATABASE_URL";

/**
 * `--target=dev` (via `pnpm db:dev:migrate`): only the guarded local
 * container. `--target=production`: only an explicit direct (non-pooled) URL
 * in PRODUCTION_DIRECT_DATABASE_URL — never the ambient DATABASE_URL, which
 * can still point at production in legacy environments.
 */
export function resolveTargetUrl(target: string | undefined): string {
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
    "Usage: db-migrate.ts --target=dev|production [--through=exact-migration-folder] (production also needs PRODUCTION_DIRECT_DATABASE_URL)",
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
    await migrateDatabase(drizzle({ client: pool, paramsInErrors: true }), {
      through: values.through,
    });
    console.log(
      `[db-migrate] ${values.target} database is current${values.through === undefined ? "" : ` through ${values.through}`}`,
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.main) await main();
