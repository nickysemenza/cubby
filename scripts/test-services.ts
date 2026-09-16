import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const postgresImage = "docker.io/pgvector/pgvector:pg17";
// Keep this aligned with the Linux CI service image.
const integresqlImage =
  "ghcr.io/allaboutapps/integresql@sha256:66b7433399f1907bad9e4b7cc7bd528ed4ebfccddecb8fd65da4af4d06a68c5a";

interface Options {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  tracing?: boolean;
}

function usesAppleServices(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  tracing: boolean,
): boolean {
  const mode = env.CUBBY_TEST_SERVICES;
  if (mode && mode !== "external" && mode !== "apple") {
    throw new Error("CUBBY_TEST_SERVICES must be apple or external");
  }
  const managed =
    tracing || (mode !== "external" && !env.CI && platform === "darwin");
  if (tracing && platform !== "darwin") {
    throw new Error(
      "Use docker compose -p cubby --profile tracing up -d on Linux",
    );
  }
  return managed;
}

export async function runWithTestServices(
  command: string[],
  {
    env = process.env,
    platform = process.platform,
    tracing = false,
  }: Options = {},
): Promise<number> {
  if (!tracing && !command.length) {
    throw new Error(
      "Usage: node scripts/test-services.ts -- <command> [arguments]",
    );
  }
  const managed = usesAppleServices(env, platform, tracing);
  const detachedCommand = managed && platform !== "win32";
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
  function cli(args: string[], timeout = 30_000): Promise<string> {
    return new Promise((resolve, reject) => {
      // A terminal Ctrl-C also signals foreground children. Isolate the CLI so
      // its create RPC finishes before cleanup, even when the wrapper is cancelled.
      const process_ = spawn("container", args, {
        env,
        detached: platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        process_.kill("SIGKILL");
        reject(new Error(`container ${args[0]} timed out after ${timeout}ms`));
      }, timeout);
      timer.unref();
      process_.stdout.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      process_.stderr.setEncoding("utf8").on("data", (data: string) => {
        stderr = (stderr + data).slice(-64_000);
      });
      process_.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      process_.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else
          reject(
            new Error(`container ${args.join(" ")} exited ${code}: ${stderr}`),
          );
      });
    });
  }
  async function start(suffix: string, args: string[]): Promise<string> {
    checkInterrupted();
    const name = `${prefix}-${suffix}`;
    // Record ownership before creation, including ambiguous/partial CLI failure.
    owned.push(name);
    console.log(`[test-services] Starting ${name}`);
    await cli(
      [
        "run",
        "--detach",
        "--rm",
        "--platform",
        "linux/arm64",
        "--name",
        name,
        ...args,
      ],
      180_000,
    );
    checkInterrupted();
    return name;
  }
  async function address(name: string): Promise<string> {
    const info = JSON.parse(await cli(["inspect", name]));
    const ip =
      String(info[0]?.status?.networks?.[0]?.ipv4Address ?? "").split("/")[0] ??
      "";
    if (isIP(ip) !== 4) {
      throw new Error(`No IPv4 address for ${name}`);
    }
    return ip;
  }
  async function waitFor(label: string, probe: () => Promise<string | void>) {
    const deadline = Date.now() + 60_000;
    let failure: unknown;
    while (Date.now() < deadline) {
      checkInterrupted();
      try {
        await probe();
        return;
      } catch (error) {
        failure = error;
        await delay(200);
      }
    }
    throw new Error(`Timed out waiting for ${label}`, { cause: failure });
  }
  async function httpReady(url: string) {
    // IntegreSQL has no health route. Any HTTP response establishes reachability;
    // template initialization in the real test setup validates its database API.
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
  }
  async function cleanup() {
    for (const name of owned.toReversed()) {
      try {
        const existing: { id: string; status: { state: string } }[] =
          JSON.parse(await cli(["list", "--all", "--format", "json"]));
        if (!Array.isArray(existing))
          throw new Error("Invalid container list response");
        const current = existing.find((entry) => entry.id === name);
        if (!current) continue;
        if (exitCode !== 0 || interrupted) {
          console.error(
            `[test-services] Logs: ${name}\n${await cli(["logs", name]).catch(String)}`,
          );
        }
        if (current.status.state === "running")
          await cli(["stop", "--time", "5", name]);
        // A failed creation may leave a stopped object. Normally --rm did this.
        const remaining = JSON.parse(
          await cli(["list", "--all", "--format", "json"]),
        );
        if (remaining.some((entry: { id: string }) => entry.id === name))
          await cli(["delete", name]);
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
  try {
    let childEnv = env;
    if (tracing) {
      await start("jaeger", [
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
      exitCode = 0;
    } else {
      if (managed) {
        const pg = await start("postgres", [
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
        ]);
        await waitFor("PostgreSQL", () =>
          cli(
            [
              "exec",
              pg,
              "pg_isready",
              "-h",
              "127.0.0.1",
              "-U",
              "postgres",
              "-d",
              "cubby",
            ],
            5_000,
          ),
        );
        const pgHost = await address(pg);
        const ig = await start("integresql", [
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
        ]);
        const url = `http://${await address(ig)}:5000`;
        await waitFor("IntegreSQL", () => httpReady(url));
        childEnv = {
          ...env,
          CUBBY_TEST_SERVICES: "external",
          INTEGRESQL_URL: url,
          INTEGRESQL_DATABASE_HOST: pgHost,
          INTEGRESQL_DATABASE_PORT: "5432",
          VITEST_MAX_WORKERS: env.VITEST_MAX_WORKERS ?? "6",
          // A report server after a failed browser run would keep the pair alive.
          PLAYWRIGHT_HTML_OPEN: env.PLAYWRIGHT_HTML_OPEN ?? "never",
        };
        console.log(
          `[test-services] Ready: PostgreSQL ${pgHost}:5432, IntegreSQL ${url}`,
        );
      }
      checkInterrupted();
      const [executable, ...args] = command;
      if (!executable) throw new Error("Missing test command");
      exitCode = await new Promise<number>((resolve, reject) => {
        child = spawn(executable, args, {
          env: childEnv,
          stdio: "inherit",
          detached: detachedCommand,
        });
        child.once("error", reject);
        child.once("close", (code, signal) =>
          resolve(
            code ??
              (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1),
          ),
        );
      });
    }
  } catch (error) {
    console.error("[test-services]", error);
  } finally {
    if (interrupted) signalGroup("SIGKILL");
    // Do not interrupt an in-flight create: its server operation may still
    // complete after the CLI dies. Finish it, then clean up by the known name.
    await cleanup();
    if (killTimer) clearTimeout(killTimer);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  return interrupted ? (interrupted === "SIGINT" ? 130 : 143) : exitCode;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  process.exitCode = await runWithTestServices(
    args[0] === "--" ? args.slice(1) : args,
    {
      tracing: args[0] === "--trace",
    },
  ).catch((error) => {
    console.error(error);
    return 1;
  });
}
