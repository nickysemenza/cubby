import { createHash } from "node:crypto";

import { tcpReady, waitFor } from "../apple/lib/apple-container.ts";
import {
  devContainerCli as containerCli,
  findDevContainer as findContainer,
  stopDevContainer as stopAndRemove,
} from "./dev-container.ts";

/**
 * The one local PostgreSQL server. Every checkout's `cubby_dev_<id>` database
 * and every test run's IntegreSQL templates live here: Virtualization.framework
 * guests never return freed pages to macOS, so a second server's footprint only
 * grew (a 4 GB test guest held ~9 GB on the host). It has no volume: all of
 * its data is synthetic, and `pnpm dev` re-creates, migrates and seeds a
 * missing checkout database.
 */
export const SHARED_POSTGRES = "cubby-dev-pg";
export const SHARED_POSTGRES_HOST = "localhost";
export const SHARED_POSTGRES_PORT = 55432;
export const SHARED_POSTGRES_USER = "postgres";
// Synthetic, local-only credential — never used outside this container.
export const SHARED_POSTGRES_PASSWORD = "password";
const DEFAULT_DATABASE = "cubby_dev";
const IMAGE = "docker.io/pgvector/pgvector:pg17";

const resources = ["--cpus", "4", "--memory", "1536M"];
const settings = [
  "shared_preload_libraries=pg_stat_statements",
  // Test speed over durability; nothing here outlives the container.
  "fsync=off",
  "synchronous_commit=off",
  "full_page_writes=off",
  "shared_buffers=128MB",
  "max_connections=300",
  // Production (Neon) has no JIT provider (`pg_jit_available()` is false),
  // but this image ships LLVM. The data-quality status/coverage SQL costs
  // far above `jit_above_cost`, so JIT compiled thousands of expressions:
  // one `dataStatus: "complete"` FinancialTransaction list took ~25 s and
  // >1.5 GB, OOM-killing PostgreSQL and stalling other files' hooks.
  "jit=off",
  "log_destination=stderr",
];
// A running container with other settings is recreated, empty.
const configuration = createHash("sha256")
  .update(JSON.stringify([IMAGE, resources, settings]))
  .digest("hex")
  .slice(0, 8);
const CONFIGURATION_ENV = `CUBBY_POSTGRES_CONFIG=${configuration}`;

async function inspectOwned() {
  if (!(await findContainer(SHARED_POSTGRES))) return undefined;
  const [info] = JSON.parse(await containerCli(["inspect", SHARED_POSTGRES]));
  const config = info?.configuration;
  const environment: string[] = config?.initProcess?.environment ?? [];
  const port = config?.publishedPorts?.some(
    (mapping: {
      hostAddress?: string;
      hostPort?: number;
      containerPort?: number;
    }) =>
      mapping.hostAddress === "127.0.0.1" &&
      mapping.hostPort === SHARED_POSTGRES_PORT &&
      mapping.containerPort === 5432,
  );
  if (
    config?.image?.reference !== IMAGE ||
    !port ||
    !environment.includes(`POSTGRES_USER=${SHARED_POSTGRES_USER}`) ||
    !environment.includes(`POSTGRES_PASSWORD=${SHARED_POSTGRES_PASSWORD}`) ||
    !environment.includes(`POSTGRES_DB=${DEFAULT_DATABASE}`)
  ) {
    throw new Error(
      `Refusing to operate on ${SHARED_POSTGRES}: container identity differs from Cubby's local PostgreSQL`,
    );
  }
  return { current: environment.includes(CONFIGURATION_ENV) };
}

/** Whether the owned container runs; throws for a foreign one. */
export async function sharedPostgresRunning(): Promise<boolean> {
  return (
    (await inspectOwned()) !== undefined &&
    (await findContainer(SHARED_POSTGRES))?.status.state === "running"
  );
}

export async function ensureSharedPostgres(): Promise<void> {
  const owned = await inspectOwned();
  const running =
    (await findContainer(SHARED_POSTGRES))?.status.state === "running";
  if (owned?.current && running) {
    console.log(`[postgres] ${SHARED_POSTGRES} is already running`);
  } else {
    if (owned) {
      if (!owned.current)
        console.log(
          `[postgres] Recreating ${SHARED_POSTGRES} with current settings; pnpm dev rebuilds each checkout's database`,
        );
      await stopAndRemove(SHARED_POSTGRES);
    }
    console.log(`[postgres] Starting ${SHARED_POSTGRES}`);
    await containerCli(
      [
        "run",
        "--detach",
        "--platform",
        "linux/arm64",
        "--name",
        SHARED_POSTGRES,
        "--publish",
        `127.0.0.1:${SHARED_POSTGRES_PORT}:5432`,
        ...resources,
        "--env",
        `POSTGRES_USER=${SHARED_POSTGRES_USER}`,
        "--env",
        `POSTGRES_PASSWORD=${SHARED_POSTGRES_PASSWORD}`,
        "--env",
        `POSTGRES_DB=${DEFAULT_DATABASE}`,
        "--env",
        CONFIGURATION_ENV,
        IMAGE,
        "postgres",
        ...settings.flatMap((setting) => ["-c", setting]),
      ],
      180_000,
    );
  }
  await waitFor(SHARED_POSTGRES, () =>
    tcpReady(SHARED_POSTGRES_HOST, SHARED_POSTGRES_PORT),
  );
  await waitFor("PostgreSQL query readiness", () => psql("SELECT 1"));
}

export async function stopSharedPostgres(): Promise<void> {
  if (!(await inspectOwned())) {
    console.log(`[postgres] ${SHARED_POSTGRES} is not running`);
    return;
  }
  await stopAndRemove(SHARED_POSTGRES);
  console.log(`[postgres] Stopped ${SHARED_POSTGRES}`);
}

/** Each statement is its own `-c`, so none shares a transaction. */
export function psql(
  statements: string | readonly string[],
  database = "postgres",
): Promise<string> {
  return containerCli([
    "exec",
    SHARED_POSTGRES,
    "psql",
    "-U",
    SHARED_POSTGRES_USER,
    "-d",
    database,
    "-tA",
    ...[statements].flat().flatMap((statement) => ["-c", statement]),
  ]);
}
