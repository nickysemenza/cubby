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
 * Retry only after PostgreSQL has rolled back the entire pending chain.
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

const NAME = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?`;
const NAMES = String.raw`${NAME}(?:\s*,\s*${NAME})*`;
const names = (list: string) => list.match(new RegExp(NAME, "g")) ?? [];
const matches = (text: string, pattern: string) =>
  [...text.matchAll(new RegExp(pattern, "gi"))].map((match) => match[1]!);

/**
 * The relations a pending chain locks beyond row level: tables it names in a
 * lock, alter, drop, truncate, index, trigger or reference, the table of each
 * index it drops, the referenced table of each constraint it drops, and the
 * foreign-key partners of each table it drops.
 */
export function pendingLockTargets(statements: readonly string[]) {
  const text = statements
    .map((statement) => statement.replace(/--[^\n]*/g, ""))
    .join("\n");
  return {
    tables: [
      ...matches(
        text,
        String.raw`\bLOCK\s+(?:TABLE\s+)?(?:ONLY\s+)?(${NAMES})`,
      ),
      ...matches(
        text,
        String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${NAME})`,
      ),
      ...matches(
        text,
        String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(${NAMES})`,
      ),
      ...matches(
        text,
        String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*?\bON\s+(?:ONLY\s+)?(${NAME})`,
      ),
      ...matches(
        text,
        String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b[^;]*?\bON\s+(${NAME})`,
      ),
      ...matches(text, String.raw`\bREFERENCES\s+(${NAME})`),
    ].flatMap(names),
    dropped: matches(
      text,
      String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${NAMES})`,
    ).flatMap(names),
    indexes: matches(
      text,
      String.raw`\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${NAMES})`,
    ).flatMap(names),
    constraints: matches(
      text,
      String.raw`\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)`,
    ).map((name) => name.replace(/^"|"$/g, "")),
  };
}

/**
 * Take every lock the pending chain needs, in its final mode and one sorted
 * order, before any of its statements reads or writes. A weaker lock taken
 * first and upgraded later in the transaction can deadlock against live
 * traffic. Relations the chain creates do not exist yet and need no lock.
 */
async function lockPendingTables(
  tx: Pick<NodePgDatabase, "execute">,
  statements: readonly string[],
): Promise<void> {
  const targets = pendingLockTargets(statements);
  const list = (values: readonly string[]) =>
    JSON.stringify([...new Set(values)]);
  const { rows } = await tx.execute<{ name: string }>(sql`
    WITH pending_lock_targets(oid) AS (
      SELECT to_regclass(name) FROM jsonb_array_elements_text(${list([...targets.tables, ...targets.dropped])}::jsonb) target(name)
      UNION SELECT i.indrelid FROM jsonb_array_elements_text(${list(targets.indexes)}::jsonb) target(name)
        JOIN pg_index i ON i.indexrelid = to_regclass(name)
      UNION SELECT c.confrelid FROM pg_constraint c
        WHERE c.contype = 'f' AND c.conname IN (SELECT jsonb_array_elements_text(${list(targets.constraints)}::jsonb))
      UNION SELECT CASE WHEN c.conrelid = d.oid THEN c.confrelid ELSE c.conrelid END
        FROM jsonb_array_elements_text(${list(targets.dropped)}::jsonb) target(name)
        CROSS JOIN LATERAL (SELECT to_regclass(name) oid) d
        JOIN pg_constraint c ON c.contype = 'f' AND d.oid IN (c.conrelid, c.confrelid)
    )
    SELECT format('%I.%I', n.nspname, c.relname) AS name
    FROM pending_lock_targets t
    JOIN pg_class c ON c.oid = t.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND c.relpersistence <> 't'
    ORDER BY 1`);
  if (rows.length)
    await tx.execute(
      sql.raw(
        `LOCK TABLE ${rows.map((row) => row.name).join(", ")} IN ACCESS EXCLUSIVE MODE`,
      ),
    );
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
  // Bookkeeping and extension DDL must have the same bounded lock wait as SQL.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await ensureDbExtensions(tx);
    // SAFETY: the native migrator accepts the node-postgres transaction HKT.
    const migrationDb = tx as Parameters<typeof migrate>[1];
    await migrate(
      migrations.filter((entry) => applied.has(entry.name)),
      migrationDb,
      { migrationsFolder },
    );
  });
  const pending = migrations
    .slice(0, boundary + 1)
    .filter((entry) => !applied.has(entry.name));
  // All pending DDL, retained data and receipts share one rollback boundary.
  // Historical files used concurrent indexes and repeatable batches. Keep their
  // immutable hashes while building indexes transactionally and draining batches.
  await retryingLockContention(
    () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        await lockPendingTables(
          tx,
          pending.flatMap((migration) => migration.sql),
        );
        for (const migration of pending) {
          for (const source of migration.sql) {
            const statement = source.replace(/\bCONCURRENTLY\b/gi, "");
            if (source.includes("-- cubby:outside-transaction")) {
              const { rows } = await tx.execute<{ name: string }>(sql`
              SELECT c.relname AS name FROM pg_index i
              JOIN pg_class c ON c.oid = i.indexrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE NOT i.indisvalid AND n.nspname = current_schema()`);
              for (const { name } of rows)
                if (statement.includes(`"${name}"`))
                  await tx.execute(
                    sql.raw(`DROP INDEX "${name.replaceAll('"', '""')}"`),
                  );
            }
            let remaining: boolean;
            do {
              const result = await tx.execute<{ remaining: boolean }>(
                sql.raw(statement),
              );
              remaining = source.includes("-- cubby:repeat-batch")
                ? z.object({ remaining: z.boolean() }).parse(result.rows[0])
                    .remaining
                : false;
            } while (remaining);
          }
          await tx.execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name)
          VALUES (${migration.hash}, ${migration.folderMillis}, ${migration.name})`);
        }
      }),
    {
      retries: TRANSACTION_LOCK_RETRIES,
      delayMs: options.lockRetryDelayMs ?? TRANSACTION_LOCK_RETRY_DELAY_MS,
    },
  );
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
