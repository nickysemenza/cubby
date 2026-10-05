import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevProfile } from "./lib/dev-profile.ts";
import { spawnToExit } from "./lib/run.ts";

import {
  containerCli,
  findContainer,
  stopAndRemove,
  tcpReady,
  waitFor,
} from "./lib/apple-container.ts";

/**
 * A persistent local PostgreSQL for `pnpm dev` iteration — separate
 * from the ephemeral/warm containers scripts/test-services.ts manages for
 * test runs. Fixed name, fixed published port, named volume: `up` is
 * idempotent and data survives across runs until `down` (which stops the
 * container but keeps the volume) or a manual `container volume rm`.
 */
const DEV_DB_CONTAINER = "cubby-dev-pg";
const DEV_DB_VOLUME = "cubby-dev-pg-data";
const DEV_DB_HOST = "localhost";
const DEV_DB_PORT = 55432;
const DEV_DB_NAME = "cubby_dev";
const DEV_DB_USER = "postgres";
// Synthetic, local-only credential — never used outside this dev container.
const DEV_DB_PASSWORD = "password";
const profile = resolveDevProfile(
  path.resolve(import.meta.dirname, ".."),
  process.env,
);
const devDatabaseName = profile.name;
const DEV_DATABASE_URL = profile.databaseUrl;

const postgresImage = "docker.io/pgvector/pgvector:pg17";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "../apps/web");
async function assertOwnedContainer(): Promise<boolean> {
  if (!(await findContainer(DEV_DB_CONTAINER))) return false;
  const [info] = JSON.parse(await containerCli(["inspect", DEV_DB_CONTAINER]));
  const config = info?.configuration;
  const environments: string[] = config?.initProcess?.environment ?? [];
  const volume = config?.mounts?.some(
    (mount: { destination?: string; type?: { volume?: { name?: string } } }) =>
      mount.destination === "/cubby-devdata" &&
      mount.type?.volume?.name === DEV_DB_VOLUME,
  );
  const port = config?.publishedPorts?.some(
    (mapping: {
      hostAddress?: string;
      hostPort?: number;
      containerPort?: number;
    }) =>
      mapping.hostAddress === "127.0.0.1" &&
      mapping.hostPort === DEV_DB_PORT &&
      mapping.containerPort === 5432,
  );
  if (
    config?.image?.reference !== postgresImage ||
    !volume ||
    !port ||
    !environments.includes(`POSTGRES_USER=${DEV_DB_USER}`) ||
    !environments.includes(`POSTGRES_PASSWORD=${DEV_DB_PASSWORD}`) ||
    !environments.includes(`POSTGRES_DB=${DEV_DB_NAME}`)
  ) {
    throw new Error(
      `Refusing to operate on ${DEV_DB_CONTAINER}: container identity differs from Cubby's local development PostgreSQL`,
    );
  }
  return true;
}

async function up(): Promise<void> {
  const existing = await findContainer(DEV_DB_CONTAINER);
  if (existing) await assertOwnedContainer();
  if (existing?.status.state === "running") {
    console.log(`[dev-db] ${DEV_DB_CONTAINER} is already running`);
  } else {
    if (existing) await stopAndRemove(DEV_DB_CONTAINER);
    console.log(`[dev-db] Starting ${DEV_DB_CONTAINER}`);
    await containerCli(
      [
        "run",
        "--detach",
        "--platform",
        "linux/arm64",
        "--name",
        DEV_DB_CONTAINER,
        "--publish",
        `127.0.0.1:${DEV_DB_PORT}:5432`,
        // A subdirectory under the mount, not the mount point itself: a fresh
        // named volume's mount point contains `lost+found`, which fails
        // `initdb`'s "directory exists but is not empty" check.
        "--volume",
        `${DEV_DB_VOLUME}:/cubby-devdata`,
        "--cpus",
        "2",
        "--memory",
        "1G",
        "--env",
        `POSTGRES_USER=${DEV_DB_USER}`,
        "--env",
        `POSTGRES_PASSWORD=${DEV_DB_PASSWORD}`,
        "--env",
        `POSTGRES_DB=${DEV_DB_NAME}`,
        "--env",
        "PGDATA=/cubby-devdata/pgdata",
        postgresImage,
      ],
      180_000,
    );
  }
  await waitFor("cubby-dev-pg", () => tcpReady(DEV_DB_HOST, DEV_DB_PORT));
  console.log(`[dev-db] Ready: ${DEV_DATABASE_URL}`);
}

async function down(): Promise<void> {
  const existing = await findContainer(DEV_DB_CONTAINER);
  if (!existing) {
    console.log(`[dev-db] ${DEV_DB_CONTAINER} is not running`);
    return;
  }
  await assertOwnedContainer();
  await stopAndRemove(DEV_DB_CONTAINER);
  console.log(
    `[dev-db] Stopped ${DEV_DB_CONTAINER} (volume ${DEV_DB_VOLUME} kept; ` +
      `\`container volume rm ${DEV_DB_VOLUME}\` to wipe data)`,
  );
}

async function assertRunningOwnedContainer(): Promise<void> {
  if (
    !(await assertOwnedContainer()) ||
    (await findContainer(DEV_DB_CONTAINER))?.status.state !== "running"
  ) {
    throw new Error(
      `Start the owned ${DEV_DB_CONTAINER} container with \`pnpm db:dev:up\` first`,
    );
  }
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

function psql(sql: string): Promise<string> {
  return containerCli([
    "exec",
    DEV_DB_CONTAINER,
    "psql",
    "-U",
    DEV_DB_USER,
    "-d",
    "postgres",
    "-tAc",
    sql,
  ]);
}

/** Each checkout's selected database is created on first use. */
async function ensureDatabase(): Promise<void> {
  await waitFor("PostgreSQL query readiness", () => psql("SELECT 1"));
  const exists = await psql(
    `SELECT 1 FROM pg_database WHERE datname = '${devDatabaseName}'`,
  );
  if (exists.trim() === "1") return;
  await psql(`CREATE DATABASE "${devDatabaseName}"`);
  console.log(`[dev-db] Created ${devDatabaseName}`);
}

async function ready(): Promise<number> {
  await up();
  await ensureDatabase();
  const migrated = await runInWebWorkspace("db-migrate.ts", ["--target=dev"]);
  if (migrated !== 0) {
    console.error(
      "[dev-db] Migration failed. `pnpm dev:reset` discards this synthetic local database and rebuilds it from the migrations.",
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
  if (process.platform !== "darwin")
    throw new Error(
      "Local development requires macOS Apple container; CI uses external test services.",
    );
  if (process.env.CUBBY_DEV_SERVICES)
    throw new Error(
      "Local development uses Apple container; unset CUBBY_DEV_SERVICES.",
    );
  const [command] = process.argv.slice(2);
  switch (command) {
    case "up":
      await up();
      return 0;
    case "down":
      await down();
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
