import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevProfile } from "./lib/dev-profile.ts";
import { spawnToExit } from "./lib/run.ts";

import {
  ensureSharedPostgres,
  psql,
  sharedPostgresRunning,
  stopSharedPostgres,
} from "./lib/shared-postgres.ts";
import { devContainerBackend } from "./lib/dev-container.ts";

/**
 * `pnpm dev` iteration on the shared local PostgreSQL
 * (scripts/lib/shared-postgres.ts), one `cubby_dev_<id>` database per
 * checkout. `up` is idempotent; a recreated container starts empty and `ready`
rebuilds the database.
 */
const profile = resolveDevProfile(
  path.resolve(import.meta.dirname, ".."),
  process.env,
);
const devDatabaseName = profile.name;
const DEV_DATABASE_URL = profile.databaseUrl;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "../apps/web");

async function up(): Promise<void> {
  await ensureSharedPostgres();
  console.log(`[dev-db] Ready: ${DEV_DATABASE_URL}`);
}

async function assertRunningOwnedContainer(): Promise<void> {
  if (!(await sharedPostgresRunning()))
    throw new Error(
      "Start the shared PostgreSQL container with `pnpm db:dev:up` first",
    );
}

/** Migrations need apps/web's own database dependencies. */
function runInWebWorkspace(
  script: string,
  args: string[] = [],
): Promise<number> {
  return spawnToExit(
    "pnpm",
    ["exec", "tsx", path.join("tooling", script), ...args],
    {
      cwd: webRoot,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: DEV_DATABASE_URL },
    },
  );
}

/** Each checkout's selected database is created on first use. */
async function ensureDatabase(): Promise<void> {
  const exists = await psql(
    `SELECT 1 FROM pg_database WHERE datname = '${devDatabaseName}'`,
  );
  if (exists.trim() !== "1") {
    await psql(`CREATE DATABASE "${devDatabaseName}"`);
    console.log(`[dev-db] Created ${devDatabaseName}`);
  }
  await psql(
    "CREATE EXTENSION IF NOT EXISTS pg_stat_statements",
    devDatabaseName,
  );
  await psql("SELECT 1 FROM pg_stat_statements LIMIT 1", devDatabaseName);
}

async function ready(): Promise<number> {
  await up();
  await ensureDatabase();
  const migrated = await runInWebWorkspace("db-migrate.ts", ["--target=dev"]);
  if (migrated !== 0) {
    console.error(
      "[dev-db] Migration failed. `pnpm dev reset` discards this synthetic local database and rebuilds it from the migrations.",
    );
    return migrated;
  }
  return 0;
}

async function reset(): Promise<number> {
  await assertRunningOwnedContainer();
  // The shared service contains other checkouts' databases.
  await psql(`DROP DATABASE IF EXISTS "${devDatabaseName}" WITH (FORCE)`);
  return ready();
}

async function main(): Promise<number> {
  devContainerBackend();
  const [command] = process.argv.slice(2);
  switch (command) {
    case "up":
      await up();
      return 0;
    case "down":
      await stopSharedPostgres();
      return 0;
    case "migrate":
      await assertRunningOwnedContainer();
      await ensureDatabase();
      return runInWebWorkspace("db-migrate.ts", ["--target=dev"]);
    case "ready":
      return ready();
    case "reset":
      return reset();
    default:
      console.error(
        "Usage: node scripts/dev-db.ts <up|migrate|ready|reset|down>",
      );
      return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main().catch((error) => {
    console.error("[dev-db]", error);
    return 1;
  });
}
