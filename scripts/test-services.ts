import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  containerAddress,
  findContainer,
  httpReady,
  listContainers,
  runDetached,
  stopAndRemove,
  tcpReady,
  waitFor,
} from "./lib/apple-container.ts";
import { spawnToExit } from "./lib/run.ts";

const postgresImage = "docker.io/pgvector/pgvector:pg17";
// Keep this aligned with the Linux CI service image.
const integresqlImage =
  "ghcr.io/allaboutapps/integresql@sha256:66b7433399f1907bad9e4b7cc7bd528ed4ebfccddecb8fd65da4af4d06a68c5a";

// Fixed names reused by `warm` mode so repeat runs find (and reuse) the same
// containers instead of paying full startup + template-rebuild cost per run.
export const WARM_POSTGRES_NAME = "cubby-test-pg";
export const WARM_INTEGRESQL_NAME = "cubby-test-integresql";

interface Options {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  warm?: boolean;
}

export type ServiceMode = "apple" | "external" | "warm";

export function serviceMode(
  env: NodeJS.ProcessEnv,
  warmFlag: boolean,
): ServiceMode {
  const mode = env.CUBBY_TEST_SERVICES;
  if (mode && mode !== "external" && mode !== "apple" && mode !== "warm") {
    throw new Error("CUBBY_TEST_SERVICES must be apple, external, or warm");
  }
  if (warmFlag) return "warm";
  // SAFETY: the guard above already rejected every string value other than
  // "external", "apple", "warm", or undefined.
  return (mode as ServiceMode | undefined) ?? "apple";
}

function usesAppleServices(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  mode: ServiceMode,
): boolean {
  const managed = mode !== "external" && !env.CI && platform === "darwin";
  if (mode === "warm" && (env.CI || platform !== "darwin")) {
    throw new Error(
      "CUBBY_TEST_SERVICES=warm (or --warm) needs macOS Apple `container` outside CI; use the default mode instead",
    );
  }
  return managed;
}

function logPhase(label: string, startedAt: number): void {
  console.log(`[test-services] ${label} in ${Date.now() - startedAt}ms`);
}

/** SIGKILL cannot run finally. Recover only unmounted disposable test services
 * whose owner PID is gone; persistent dev/warm services and live runs survive. */
export async function pruneAbandonedServices(): Promise<void> {
  for (const entry of await listContainers()) {
    const match = /^cubby-([1-9]\d*)-[0-9a-f]{8}-(postgres|integresql)$/.exec(
      entry.id,
    );
    if (!match) continue;
    const image = match[2] === "postgres" ? postgresImage : integresqlImage;
    if (
      entry.configuration?.image?.reference !== image ||
      !Array.isArray(entry.configuration.mounts) ||
      entry.configuration.mounts.length !== 0
    )
      continue;
    try {
      process.kill(Number(match[1]), 0);
      continue;
    } catch (error) {
      // EPERM also means a process exists. Unknown errors cannot prove abandonment.
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        continue;
    }
    await stopAndRemove(entry.id);
    console.log(`[test-services] Recovered abandoned ${entry.id}`);
  }
}

/** Remove the fixed-name warm containers. Used by `pnpm test:services:down`. */
export async function stopWarmServices(): Promise<void> {
  for (const name of [WARM_INTEGRESQL_NAME, WARM_POSTGRES_NAME]) {
    const existing = await findContainer(name);
    if (!existing) {
      console.log(`[test-services] ${name} is not running`);
      continue;
    }
    await stopAndRemove(name);
    console.log(`[test-services] Removed ${name}`);
  }
}

export async function runWithTestServices(
  command: string[],
  {
    env = process.env,
    platform = process.platform,
    warm = false,
  }: Options = {},
): Promise<number> {
  if (!command.length) {
    throw new Error(
      "Usage: node scripts/test-services.ts -- <command> [arguments]",
    );
  }
  const mode = serviceMode(env, warm);
  const managed = usesAppleServices(env, platform, mode);
  const detachedCommand = managed && platform !== "win32";
  const isWarm = mode === "warm";
  const owned: string[] = [];
  const prefix = `cubby-${process.pid}-${randomUUID().slice(0, 8)}`;
  let child: ChildProcess | undefined;
  let interrupted: NodeJS.Signals | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let exitCode = 1;

  function signalGroup(signal: NodeJS.Signals) {
    if (!child?.pid) return;
    try {
      if (!detachedCommand) child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        throw error;
    }
  }
  function interrupt(signal: NodeJS.Signals) {
    if (interrupted) return;
    interrupted = signal;
    signalGroup(signal);
    // Kill the whole group, including a synchronous pnpm/Vitest grandchild.
    killTimer = setTimeout(() => signalGroup("SIGKILL"), 5_000);
    killTimer.unref();
  }
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  function checkInterrupted() {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  }

  /** Ephemeral (cold) container: always created fresh, always torn down after. */
  async function startEphemeral(
    suffix: string,
    args: string[],
  ): Promise<string> {
    checkInterrupted();
    const name = `${prefix}-${suffix}`;
    owned.push(name);
    console.log(`[test-services] Starting ${name}`);
    await runDetached(name, args);
    checkInterrupted();
    return name;
  }

  /** Warm container: reused across runs if already present and healthy. */
  async function startWarm(
    name: string,
    args: string[],
    healthy: () => Promise<string | void>,
    { forceRecreate = false }: { forceRecreate?: boolean } = {},
  ): Promise<{ name: string; reused: boolean }> {
    checkInterrupted();
    const existing = await findContainer(name);
    if (existing?.status.state === "running" && !forceRecreate) {
      try {
        await healthy();
        console.log(`[test-services] Reusing warm ${name}`);
        return { name, reused: true };
      } catch {
        console.log(`[test-services] Warm ${name} unhealthy; recreating`);
        await stopAndRemove(name);
      }
    } else if (existing) {
      await stopAndRemove(name);
    }
    console.log(`[test-services] Starting warm ${name}`);
    await runDetached(name, args, { rm: false });
    checkInterrupted();
    return { name, reused: false };
  }

  async function cleanupEphemeral() {
    for (const name of owned.toReversed()) {
      try {
        const existing = await findContainer(name);
        if (!existing) continue;
        await stopAndRemove(name, {
          logsOnFailure: exitCode !== 0 || !!interrupted,
        });
        console.log(`[test-services] Removed ${name}`);
      } catch (error) {
        exitCode = 1;
        console.error(
          `[test-services] Cleanup failed for ${name}; run container stop ${name}`,
          error,
        );
      }
    }
  }

  /** Start (or reuse, in warm mode) PostgreSQL + IntegreSQL and return the env overlay. */
  async function startDatabaseServices(): Promise<NodeJS.ProcessEnv> {
    const pgArgs = [
      "--cpus",
      "4",
      "--memory",
      "2G",
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      "POSTGRES_PASSWORD=password",
      "--env",
      "POSTGRES_DB=cubby",
      "--env",
      "PGDATA=/cubby-testdata",
      postgresImage,
      "postgres",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
      "-c",
      "shared_buffers=512MB",
      "-c",
      "max_connections=200",
      // Production (Neon) has no JIT provider (`pg_jit_available()` is false),
      // but this image ships LLVM. The data-quality status/coverage SQL costs
      // far above `jit_above_cost`, so JIT compiled thousands of expressions:
      // one `dataStatus: "complete"` FinancialTransaction list took ~25 s and
      // >1.5 GB here, OOM-killing PostgreSQL and stalling other files' hooks.
      "-c",
      "jit=off",
      "-c",
      "log_destination=stderr",
    ];

    const pgStart = Date.now();
    let pg: string;
    let pgReused = false;
    if (isWarm) {
      // The container has no published port yet at this point, so probe
      // readiness through its internal address once it exists.
      const result = await startWarm(WARM_POSTGRES_NAME, pgArgs, async () => {
        const ip = await containerAddress(WARM_POSTGRES_NAME);
        await tcpReady(ip, 5432);
      });
      pg = result.name;
      pgReused = result.reused;
    } else {
      pg = await startEphemeral("postgres", pgArgs);
    }

    // Start IntegreSQL concurrently with waiting for PostgreSQL: IntegreSQL
    // only needs PostgreSQL's *address*, not full readiness, to be created —
    // its own connections retry until PostgreSQL accepts them.
    const pgHost = await containerAddress(pg);
    const pgReadyPromise = pgReused
      ? Promise.resolve()
      : waitFor("PostgreSQL", () => tcpReady(pgHost, 5432));

    const igArgs = [
      "--cpus",
      "1",
      "--memory",
      "256M",
      "--env",
      `PGHOST=${pgHost}`,
      "--env",
      "PGUSER=postgres",
      "--env",
      "PGPASSWORD=password",
      "--env",
      "INTEGRESQL_TEST_INITIAL_POOL_SIZE=8",
      "--env",
      "INTEGRESQL_TEST_MAX_POOL_SIZE=16",
      "--env",
      "INTEGRESQL_POOL_MAX_PARALLEL_TASKS=4",
      integresqlImage,
    ];

    const igStart = Date.now();
    let ig: string;
    if (isWarm) {
      const result = await startWarm(
        WARM_INTEGRESQL_NAME,
        igArgs,
        async () => {
          const ip = await containerAddress(WARM_INTEGRESQL_NAME);
          await httpReady(`http://${ip}:5000`);
        },
        // IntegreSQL bakes PostgreSQL's address into its env at creation
        // time. A freshly (re)started PostgreSQL container almost always
        // has a new address, so a stale IntegreSQL container must be
        // recreated rather than reused even if it still answers HTTP.
        { forceRecreate: !pgReused },
      );
      ig = result.name;
      if (!result.reused) {
        await pgReadyPromise;
        logPhase("PostgreSQL ready", pgStart);
        await waitFor("IntegreSQL", async () =>
          httpReady(`http://${await containerAddress(ig)}:5000`),
        );
      }
    } else {
      ig = await startEphemeral("integresql", igArgs);
      await pgReadyPromise;
      logPhase("PostgreSQL ready", pgStart);
      await waitFor("IntegreSQL", async () =>
        httpReady(`http://${await containerAddress(ig)}:5000`),
      );
    }
    logPhase(isWarm ? "IntegreSQL ready (warm)" : "IntegreSQL ready", igStart);

    const url = `http://${await containerAddress(ig)}:5000`;
    console.log(
      `[test-services] Ready: PostgreSQL ${pgHost}:5432, IntegreSQL ${url}`,
    );
    return {
      CUBBY_TEST_SERVICES: "external",
      INTEGRESQL_URL: url,
      INTEGRESQL_DATABASE_HOST: pgHost,
      INTEGRESQL_DATABASE_PORT: "5432",
      VITEST_MAX_WORKERS: env.VITEST_MAX_WORKERS ?? "6",
      // A report server after a failed browser run would keep the pair alive.
      PLAYWRIGHT_HTML_OPEN: env.PLAYWRIGHT_HTML_OPEN ?? "never",
    };
  }

  function runCommand(childEnv: NodeJS.ProcessEnv): Promise<number> {
    checkInterrupted();
    const [executable, ...args] = command;
    if (!executable) throw new Error("Missing test command");
    return spawnToExit(executable, args, {
      env: childEnv,
      stdio: "inherit",
      detached: detachedCommand,
      onSpawn: (spawned) => {
        child = spawned;
      },
    });
  }

  try {
    if (managed) await pruneAbandonedServices();
    const childEnv = managed
      ? { ...env, ...(await startDatabaseServices()) }
      : env;
    exitCode = await runCommand(childEnv);
  } catch (error) {
    console.error("[test-services]", error);
  } finally {
    if (interrupted) signalGroup("SIGKILL");
    // Do not interrupt an in-flight create: its server operation may still
    // complete after the CLI dies. Finish it, then clean up by the known name.
    if (!isWarm) await cleanupEphemeral();
    if (killTimer) clearTimeout(killTimer);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  return interrupted ? (interrupted === "SIGINT" ? 130 : 143) : exitCode;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--down" || args[0] === "--prune") {
    process.exitCode = await (
      args[0] === "--down" ? stopWarmServices() : pruneAbandonedServices()
    ).then(
      () => 0,
      (error) => {
        console.error(error);
        return 1;
      },
    );
  } else {
    const warm = args[0] === "--warm";
    const rest = warm ? args.slice(1) : args;
    process.exitCode = await runWithTestServices(
      rest[0] === "--" ? rest.slice(1) : rest,
      {
        warm,
      },
    ).catch((error) => {
      console.error(error);
      return 1;
    });
  }
}
