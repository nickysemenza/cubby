import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  containerCli,
  findContainer,
  stopAndRemove,
  tcpReady,
  waitFor,
} from "./lib/apple-container.ts";

/**
 * A persistent local PostgreSQL for `pnpm dev:local` iteration — separate
 * from the ephemeral/warm containers scripts/test-services.ts manages for
 * test runs. Fixed name, fixed published port, named volume: `up` is
 * idempotent and data survives across runs until `down` (which stops the
 * container but keeps the volume) or a manual `container volume rm`.
 */
export const DEV_DB_CONTAINER = "cubby-dev-pg";
export const DEV_DB_VOLUME = "cubby-dev-pg-data";
export const DEV_DB_HOST = "localhost";
export const DEV_DB_PORT = 55432;
export const DEV_DB_NAME = "cubby_dev";
export const DEV_DB_USER = "postgres";
// Synthetic, local-only credential — never used outside this dev container.
export const DEV_DB_PASSWORD = "password";
export const DEV_DATABASE_URL = `postgresql://${DEV_DB_USER}:${DEV_DB_PASSWORD}@${DEV_DB_HOST}:${DEV_DB_PORT}/${DEV_DB_NAME}`;

const postgresImage = "docker.io/pgvector/pgvector:pg17";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "../apps/web");

async function up(): Promise<void> {
  const existing = await findContainer(DEV_DB_CONTAINER);
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
  await stopAndRemove(DEV_DB_CONTAINER);
  console.log(
    `[dev-db] Stopped ${DEV_DB_CONTAINER} (volume ${DEV_DB_VOLUME} kept; ` +
      `\`container volume rm ${DEV_DB_VOLUME}\` to wipe data)`,
  );
}

/** `push` and `seed` need apps/web's own deps (drizzle-kit, pg, faker, the entity kernel). */
function runInWebWorkspace(script: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", path.join("tooling", script)], {
      cwd: webRoot,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: DEV_DATABASE_URL },
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<number> {
  const [command] = process.argv.slice(2);
  switch (command) {
    case "up":
      await up();
      return 0;
    case "down":
      await down();
      return 0;
    case "push":
      return runInWebWorkspace("dev-db-push.ts");
    case "seed":
      return runInWebWorkspace("dev-db-seed.ts");
    default:
      console.error("Usage: node scripts/dev-db.ts <up|push|seed|down>");
      return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main().catch((error) => {
    console.error("[dev-db]", error);
    return 1;
  });
}
