import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevProfile, DEV_DATABASE_ENV_KEYS } from "./lib/dev-profile.ts";
import { spawnToExit } from "./lib/run.ts";

import {
  ensureSharedPostgres,
  psql,
  sharedPostgresRunning,
  resolveOwnedDevProfile,
  stopSharedPostgres,
} from "./lib/shared-postgres.ts";
import { devContainerBackend } from "./lib/dev-container.ts";

/**
 * `pnpm dev` iteration on the shared local PostgreSQL
 * (scripts/lib/shared-postgres.ts), one `cubby_dev_<id>` database per
 * checkout. `up` is idempotent; a recreated container starts empty and `ready`
rebuilds the database.
 */
let profile = resolveDevProfile(
  path.resolve(import.meta.dirname, ".."),
  process.env,
);
const devDatabaseName = profile.name;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "../apps/web");

async function bindOwnedProfile(): Promise<void> {
  profile = await resolveOwnedDevProfile(profile.repoRoot);
  process.env.CUBBY_DEV_DB_ADDRESS = new URL(profile.databaseUrl).host;
  // Repeated readiness/reset binding must validate one consistent endpoint.
  for (const key of DEV_DATABASE_ENV_KEYS)
    if (process.env[key]) process.env[key] = profile.databaseUrl;
}

async function up(): Promise<void> {
  // Verify inherited addresses before ensureSharedPostgres can issue readiness SQL.
  if (process.env.CUBBY_DEV_DB_ADDRESS) await bindOwnedProfile();
  await ensureSharedPostgres();
  await bindOwnedProfile();
  console.log(`[dev-db] Ready: ${profile.databaseUrl}`);
}

async function assertRunningOwnedContainer(): Promise<void> {
  if (!(await sharedPostgresRunning()))
    throw new Error(
      "Start the shared PostgreSQL container with `pnpm db:dev:up` first",
    );
  await bindOwnedProfile();
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
      env: { ...process.env, DATABASE_URL: profile.databaseUrl },
    },
  );
}

/** Each checkout's selected database is created on first use. */
async function ensureDatabase(reseed = false): Promise<void> {
  const code = await spawnToExit(
    "node",
    [
      path.join(__dirname, "test-services.ts"),
      "--",
      "pnpm",
      "exec",
      "tsx",
      "tooling/dev/corpus-template.ts",
      ...(reseed ? ["--reseed"] : []),
    ],
    { cwd: webRoot, stdio: "inherit", env: process.env },
  );
  if (code !== 0) throw new Error("Dev corpus template preparation failed");
  await psql(
    "CREATE EXTENSION IF NOT EXISTS pg_stat_statements",
    devDatabaseName,
  );
  await psql("SELECT 1 FROM pg_stat_statements LIMIT 1", devDatabaseName);
}

async function ready(reseed = false): Promise<number> {
  await up();
  await ensureDatabase(reseed);
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
  return ready(process.argv.includes("--reseed"));
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
