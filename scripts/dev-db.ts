import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

/** `push` and `seed` need apps/web's own deps (drizzle-kit, pg, faker, the entity kernel). */
function runInWebWorkspace(
  script: string,
  args: string[] = [],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "tsx", path.join("tooling", script), ...args],
      {
        cwd: webRoot,
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: DEV_DATABASE_URL },
      },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function runWebCommand(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: webRoot,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: DEV_DATABASE_URL },
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function ready(): Promise<number> {
  await up();
  const pushed = await runInWebWorkspace("dev-db-push.ts");
  if (pushed !== 0) {
    console.error(
      "[dev-db] Schema push needs a rename choice. Run `pnpm db:dev:push` interactively, or `pnpm db:dev:reset` to discard this synthetic local database.",
    );
    return pushed;
  }
  if (!existsSync(path.join(webRoot, "dist/server/wrangler.json"))) {
    const built = await runWebCommand(["run", "build:cf"]);
    if (built !== 0) return built;
  }
  return runInWebWorkspace("dev-db-seed.ts", ["--if-empty"]);
}

async function reset(): Promise<number> {
  if (await assertOwnedContainer()) await stopAndRemove(DEV_DB_CONTAINER);
  await containerCli(["volume", "rm", DEV_DB_VOLUME]);
  return ready();
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
      await assertRunningOwnedContainer();
      return runInWebWorkspace("dev-db-push.ts");
    case "seed":
      await assertRunningOwnedContainer();
      return runInWebWorkspace("dev-db-seed.ts");
    case "ready":
      return ready();
    case "reset":
      return reset();
    default:
      console.error(
        "Usage: node scripts/dev-db.ts <up|push|seed|ready|reset|down>",
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
