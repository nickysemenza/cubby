import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  containerAddress,
  findContainer,
  httpReady,
  runDetached,
  stopAndRemove,
  tcpReady,
  waitFor,
} from "./lib/apple-container.ts";

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
  tracing?: boolean;
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
  tracing: boolean,
  mode: ServiceMode,
): boolean {
  const managed =
    tracing || (mode !== "external" && !env.CI && platform === "darwin");
  if (tracing && platform !== "darwin") {
    throw new Error(
      "Use docker compose -p cubby --profile tracing up -d on Linux",
    );
  }
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
    tracing = false,
    warm = false,
  }: Options = {},
): Promise<number> {
  if (!tracing && !command.length) {
    throw new Error(
      "Usage: node scripts/test-services.ts -- <command> [arguments]",
    );
  }
  const mode = serviceMode(env, warm);
  const managed = usesAppleServices(env, platform, tracing, mode);
  const detachedCommand = managed && platform !== "win32";
  const isWarm = mode === "warm" && !tracing;
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

  async function runTracing(): Promise<number> {
    await startEphemeral("jaeger", [
      "--cpus",
      "1",
      "--memory",
      "256M",
      "--publish",
      "127.0.0.1:16686:16686",
      "--publish",
      "127.0.0.1:4318:4318",
      "--publish",
      "127.0.0.1:4317:4317",
      // Official Docker Hub image: Apple's runtime rejects the cross-domain
      // auth redirect from cr.jaegertracing.io to auth.docker.io.
      "docker.io/jaegertracing/jaeger:2.20.0",
    ]);
    await waitFor("Jaeger", () => httpReady("http://127.0.0.1:16686"));
    console.log(
      "[test-services] Jaeger: http://localhost:16686 — Ctrl-C to stop",
    );
    // Signal listeners alone do not keep Node alive while the container is detached.
    for (;;) {
      if (interrupted) break;
      await delay(200);
    }
    return 0;
  }

  function runCommand(childEnv: NodeJS.ProcessEnv): Promise<number> {
    checkInterrupted();
    const [executable, ...args] = command;
    if (!executable) throw new Error("Missing test command");
    return new Promise<number>((resolve, reject) => {
      child = spawn(executable, args, {
        env: childEnv,
        stdio: "inherit",
        detached: detachedCommand,
      });
      child.once("error", reject);
      child.once("close", (code, signal) =>
        resolve(
          code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1),
        ),
      );
    });
  }

  try {
    if (tracing) {
      exitCode = await runTracing();
    } else {
      const childEnv = managed
        ? { ...env, ...(await startDatabaseServices()) }
        : env;
      exitCode = await runCommand(childEnv);
    }
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
  if (args[0] === "--down") {
    process.exitCode = await stopWarmServices().then(
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
        tracing: rest[0] === "--trace",
        warm,
      },
    ).catch((error) => {
      console.error(error);
      return 1;
    });
  }
}
