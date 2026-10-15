import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  containerAddress,
  containerCli,
  findContainer,
  httpReady,
  listContainers,
  runDetached,
  stopAndRemove,
  tcpReady,
  waitFor,
} from "./apple/lib/apple-container.ts";
import { holdLock, ownerIsAlive, worktreeRoot } from "./lib/harness-lock.ts";
import { spawnToExit } from "./lib/run.ts";

const postgresImage = "docker.io/pgvector/pgvector:pg17";
// Keep this aligned with the Linux CI service image.
const integresqlImage =
  "ghcr.io/allaboutapps/integresql@sha256:66b7433399f1907bad9e4b7cc7bd528ed4ebfccddecb8fd65da4af4d06a68c5a";

const postgresArgs = [
  // Every worktree's runs share this one server.
  "--cpus",
  "6",
  "--memory",
  "4G",
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
  "max_connections=400",
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

const integresqlArgs = (postgresHost: string) => [
  "--cpus",
  "1",
  "--memory",
  "256M",
  "--env",
  `PGHOST=${postgresHost}`,
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

/**
 * The shared pair is named for its configuration, so a checkout on another
 * revision of this file starts its own pair instead of reusing or recreating
 * one that live runs depend on.
 */
const configuration = createHash("sha256")
  .update(JSON.stringify([postgresArgs, integresqlArgs("")]))
  .digest("hex")
  .slice(0, 8);
const pairName = (config: string, service: "postgres" | "integresql") =>
  `cubby-test-${config}-${service}`;
const POSTGRES = pairName(configuration, "postgres");
const INTEGRESQL = pairName(configuration, "integresql");
const PAIR_NAME = /^cubby-test-([0-9a-f]{8})-(?:postgres|integresql)$/;

/**
 * Machine-wide state: a lock serializing service startup and teardown, and one
 * record per live run naming the pair it uses.
 */
const STATE = "/tmp/cubby-test-services";
const RUNS = path.join(STATE, "runs");
// Startup never blocks the event loop, so a killed starter's lock goes stale fast.
const STATE_LOCK = { path: STATE, label: "test services", staleMs: 30_000 };

/**
 * Templates and their pools accumulate per worktree and schema revision
 * (about 14 MB each); an idle pair holding more databases than this is
 * recreated empty.
 */
const RECYCLE_DATABASE_COUNT = 250;

const runRecord = z.object({
  pid: z.number(),
  // The command's detached process group; it can outlive a SIGKILLed wrapper.
  group: z.number().optional(),
  configuration: z.string(),
  root: z.string(),
});
type RunRecord = z.infer<typeof runRecord>;

/**
 * Pair containers that no live run uses. `keep` names the configuration the
 * caller is about to use; teardown passes none.
 */
export function removablePairContainers(
  containers: readonly string[],
  live: readonly Pick<RunRecord, "configuration">[],
  keep?: string,
): string[] {
  const used = new Set(live.map((run) => run.configuration));
  if (keep) used.add(keep);
  return containers.filter((id) => {
    const config = PAIR_NAME.exec(id)?.[1];
    return config !== undefined && !used.has(config);
  });
}

/** Whether any process in a process group still runs. */
function groupIsAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * Live run records; a dead or unreadable record is deleted. A run stays live
 * while its wrapper or its command's process group runs.
 */
function liveRuns(): RunRecord[] {
  mkdirSync(RUNS, { recursive: true });
  return readdirSync(RUNS).flatMap((file) => {
    let record: ReturnType<typeof runRecord.safeParse> | undefined;
    try {
      record = runRecord.safeParse(
        JSON.parse(readFileSync(path.join(RUNS, file), "utf8")),
      );
    } catch {
      // Unreadable: removed below.
    }
    if (
      record?.success &&
      (ownerIsAlive(record.data.pid) ||
        (record.data.group !== undefined && groupIsAlive(record.data.group)))
    )
      return [record.data];
    rmSync(path.join(RUNS, file), { force: true });
    return [];
  });
}

const serviceModeSchema = z.enum(["apple", "external"]);
type ServiceMode = z.infer<typeof serviceModeSchema>;

function serviceMode(env: NodeJS.ProcessEnv): ServiceMode {
  return serviceModeSchema
    .default("apple")
    .parse(env.CUBBY_TEST_SERVICES || undefined);
}

function logPhase(label: string, startedAt: number): void {
  console.log(`[test-services] ${label} in ${Date.now() - startedAt}ms`);
}

/** The shared pair's PostgreSQL address when both services answer. */
async function healthyPair(): Promise<string | undefined> {
  const [postgres, integresql] = await Promise.all([
    findContainer(POSTGRES),
    findContainer(INTEGRESQL),
  ]);
  if (
    postgres?.status.state !== "running" ||
    integresql?.status.state !== "running"
  )
    return undefined;
  try {
    const postgresHost = await containerAddress(POSTGRES);
    const integresqlHost = await containerAddress(INTEGRESQL);
    // Generous: another worktree's suite may be loading the pair.
    await waitFor("PostgreSQL", () => tcpReady(postgresHost, 5432), {
      timeoutMs: 15_000,
    });
    await waitFor(
      "IntegreSQL",
      () => httpReady(`http://${integresqlHost}:5000`),
      {
        timeoutMs: 15_000,
      },
    );
    return postgresHost;
  } catch {
    console.log("[test-services] Shared services are unhealthy");
    return undefined;
  }
}

async function databaseCount(): Promise<number> {
  return Number(
    await containerCli([
      "exec",
      POSTGRES,
      "psql",
      "-U",
      "postgres",
      "-tAc",
      "SELECT count(*) FROM pg_database",
    ]),
  );
}

async function createPair(): Promise<string> {
  await stopAndRemove(INTEGRESQL);
  await stopAndRemove(POSTGRES);
  const startedAt = Date.now();
  console.log(`[test-services] Starting ${POSTGRES}`);
  await runDetached(POSTGRES, postgresArgs);
  const postgresHost = await containerAddress(POSTGRES);
  // IntegreSQL needs only PostgreSQL's address to start; its connections
  // retry until PostgreSQL accepts them.
  console.log(`[test-services] Starting ${INTEGRESQL}`);
  await runDetached(INTEGRESQL, integresqlArgs(postgresHost));
  await waitFor("PostgreSQL", () => tcpReady(postgresHost, 5432));
  logPhase("PostgreSQL ready", startedAt);
  const integresqlUrl = `http://${await containerAddress(INTEGRESQL)}:5000`;
  await waitFor("IntegreSQL", () => httpReady(integresqlUrl));
  logPhase("IntegreSQL ready", startedAt);
  return postgresHost;
}

/**
 * Register this run and make the shared pair healthy, under the machine-wide
 * startup lock: two starters never create, recycle, or remove a pair at once,
 * and a pair a live run uses is recreated only when it no longer answers.
 * Returns the environment overlay and this run's deregistration.
 */
async function joinSharedServices(env: NodeJS.ProcessEnv) {
  mkdirSync(RUNS, { recursive: true });
  const release = await holdLock(STATE_LOCK);
  const record = path.join(RUNS, `${process.pid}.json`);
  const leave = () => rmSync(record, { force: true });
  const write = (group?: number) =>
    writeFileSync(
      record,
      JSON.stringify({
        pid: process.pid,
        group,
        configuration,
        root: worktreeRoot,
      } satisfies RunRecord),
    );
  try {
    const others = liveRuns();
    write();
    for (const name of removablePairContainers(
      (await listContainers()).map((entry) => entry.id),
      others,
      configuration,
    )) {
      await stopAndRemove(name);
      console.log(`[test-services] Removed idle ${name}`);
    }
    let postgresHost = await healthyPair();
    const sharing = others.filter((run) => run.configuration === configuration);
    // Recreating the pair would destroy databases a live run is using; a
    // transient outage is the newcomer's failure, not a reason to reset.
    if (!postgresHost && sharing.length > 0)
      throw new Error(
        `Shared test services are unhealthy while live runs use them (${sharing
          .map((run) => `pid ${run.pid} in ${run.root}`)
          .join(", ")}); retry after they finish`,
      );
    if (
      postgresHost &&
      sharing.length === 0 &&
      (await databaseCount()) > RECYCLE_DATABASE_COUNT
    ) {
      console.log(
        `[test-services] Recycling idle ${POSTGRES} past ${RECYCLE_DATABASE_COUNT} databases`,
      );
      postgresHost = undefined;
    }
    postgresHost ??= await createPair();
    const integresqlUrl = `http://${await containerAddress(INTEGRESQL)}:5000`;
    console.log(
      `[test-services] Ready: PostgreSQL ${postgresHost}:5432, IntegreSQL ${integresqlUrl}`,
    );
    const overlay: NodeJS.ProcessEnv = {
      CUBBY_TEST_SERVICES: "external",
      INTEGRESQL_URL: integresqlUrl,
      INTEGRESQL_DATABASE_HOST: postgresHost,
      INTEGRESQL_DATABASE_PORT: "5432",
      VITEST_MAX_WORKERS: env.VITEST_MAX_WORKERS ?? "6",
      // A report server after a failed browser run would keep the run live.
      PLAYWRIGHT_HTML_OPEN: env.PLAYWRIGHT_HTML_OPEN ?? "never",
    };
    return { overlay, leave, adopt: (group: number) => write(group) };
  } catch (error) {
    leave();
    throw error;
  } finally {
    await release();
  }
}

/** Remove every shared pair no live run uses (`pnpm test:services:down`). */
async function stopIdleServices(): Promise<void> {
  mkdirSync(RUNS, { recursive: true });
  const release = await holdLock(STATE_LOCK);
  try {
    const live = liveRuns();
    for (const name of removablePairContainers(
      (await listContainers()).map((entry) => entry.id),
      live,
    )) {
      await stopAndRemove(name);
      console.log(`[test-services] Removed ${name}`);
    }
    for (const run of live)
      console.log(
        `[test-services] Kept ${pairName(run.configuration, "postgres")} for live run ${run.pid} in ${run.root}`,
      );
  } finally {
    await release();
  }
}

export async function runWithTestServices(
  command: string[],
  {
    env = process.env,
    platform = process.platform,
  }: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<number> {
  if (!command.length) {
    throw new Error(
      "Usage: node scripts/test-services.ts -- <command> [arguments]",
    );
  }
  const managed =
    serviceMode(env) === "apple" && !env.CI && platform === "darwin";
  // Managed means macOS, where the command runs as its own process group.
  const detachedCommand = managed;
  let child: ChildProcess | undefined;
  let interrupted: NodeJS.Signals | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let leave = () => {};
  let adopt = (_group: number) => {};
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

  try {
    let childEnv = env;
    if (managed) {
      // Startup is not interrupted mid-create: the pair is shared, and a
      // finished create leaves it usable for the next run.
      const joined = await joinSharedServices(env);
      leave = joined.leave;
      adopt = joined.adopt;
      childEnv = { ...env, ...joined.overlay };
    }
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    const [executable, ...args] = command;
    if (!executable) throw new Error("Missing test command");
    exitCode = await spawnToExit(executable, args, {
      env: childEnv,
      stdio: "inherit",
      detached: detachedCommand,
      onSpawn: (spawned) => {
        child = spawned;
        // A detached child leads its own process group.
        if (detachedCommand && spawned.pid) adopt(spawned.pid);
      },
    });
  } catch (error) {
    console.error("[test-services]", error);
  } finally {
    if (interrupted) signalGroup("SIGKILL");
    // A descendant can outlive the group leader; its still-live group keeps
    // the record, and liveRuns deletes it once the group is gone.
    if (!(detachedCommand && child?.pid && groupIsAlive(child.pid))) leave();
    if (killTimer) clearTimeout(killTimer);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  return interrupted ? (interrupted === "SIGINT" ? 130 : 143) : exitCode;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  process.exitCode = await (
    args[0] === "--down"
      ? stopIdleServices().then(() => 0)
      : runWithTestServices(args[0] === "--" ? args.slice(1) : args)
  ).catch((error) => {
    console.error(error);
    return 1;
  });
}
