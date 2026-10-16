import { retireTemplateMarkers } from "./lib/template-markers.ts";
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
  httpReady,
  waitFor,
} from "./apple/lib/apple-container.ts";
import {
  devContainerBackend,
  devContainerCli as containerCli,
  findDevContainer as findContainer,
  stopDevContainer as stopAndRemove,
} from "./lib/dev-container.ts";
import { holdLock, ownerIsAlive, worktreeRoot } from "./lib/harness-lock.ts";
import { spawnToExit } from "./lib/run.ts";
import {
  SHARED_POSTGRES,
  ensureSharedPostgres,
  psql,
} from "./lib/shared-postgres.ts";

// Keep this aligned with the Linux CI service image.
const integresqlImage =
  "ghcr.io/allaboutapps/integresql@sha256:66b7433399f1907bad9e4b7cc7bd528ed4ebfccddecb8fd65da4af4d06a68c5a";

const integresqlArgs = (postgresHost: string) => [
  ...(devContainerBackend() === "docker"
    ? ["--network", "cubby-local", "--publish", "127.0.0.1::5000"]
    : []),
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
  "INTEGRESQL_TEST_INITIAL_POOL_SIZE=2",
  "--env",
  // At least VITEST_MAX_WORKERS (6); every pooled copy is a whole database.
  "INTEGRESQL_TEST_MAX_POOL_SIZE=8",
  "--env",
  "INTEGRESQL_POOL_MAX_PARALLEL_TASKS=4",
  integresqlImage,
];

/**
 * IntegreSQL is named for its configuration, so a checkout on another
 * revision of this file starts its own instead of reusing or recreating one
 * that live runs depend on. Its databases live on the shared PostgreSQL
 * (scripts/lib/shared-postgres.ts); `-postgres` names are the per-pair servers
 * of earlier revisions, removed once no live run uses them.
 */
const configuration = createHash("sha256")
  .update(JSON.stringify(integresqlArgs("")))
  .digest("hex")
  .slice(0, 8);
const pairName = (config: string, service: "postgres" | "integresql") =>
  `cubby-test-${config}-${service}`;
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
 * (about 14 MB each); idle IntegreSQL holding more databases than this is
 * recreated with its databases dropped.
 */
const RECYCLE_DATABASE_COUNT = 100;

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

const serviceModeSchema = z.enum(["managed", "external"]);
type ServiceMode = z.infer<typeof serviceModeSchema>;

function serviceMode(env: NodeJS.ProcessEnv): ServiceMode {
  return serviceModeSchema
    .default("managed")
    .parse(env.CUBBY_TEST_SERVICES || undefined);
}

function logPhase(label: string, startedAt: number): void {
  console.log(`[test-services] ${label} in ${Date.now() - startedAt}ms`);
}

const INTEGRESQL_DATABASES =
  "SELECT datname FROM pg_database WHERE datname LIKE 'integresql\\_%'";

/** Docker's loopback publication is host-only; peers use their own network. */
async function connectDockerPostgres(): Promise<void> {
  if (devContainerBackend() !== "docker") return;
  const networks = JSON.parse(
    await containerCli(["network", "ls", "--format", "json"]).then(
      (output) => `[${output.split("\n").filter(Boolean).join(",")}]`,
    ),
  );
  const present = z
    .array(z.object({ Name: z.string() }))
    .parse(networks)
    .some((network) => network.Name === "cubby-local");
  if (!present) await containerCli(["network", "create", "cubby-local"]);
  const [network] = z
    .array(
      z.object({
        Containers: z.record(z.string(), z.object({ Name: z.string() })),
      }),
    )
    .parse(
      JSON.parse(await containerCli(["network", "inspect", "cubby-local"])),
    );
  if (
    !Object.values(network?.Containers ?? {}).some(
      (container) => container.Name === SHARED_POSTGRES,
    )
  )
    await containerCli(["network", "connect", "cubby-local", SHARED_POSTGRES]);
}

/** Reach the local service through Apple's address or Docker's assigned port. */
async function integresqlAddress(name = INTEGRESQL): Promise<string> {
  if (devContainerBackend() === "apple")
    return `http://${await containerAddress(name)}:5000`;
  const [info] = JSON.parse(await containerCli(["inspect", name]));
  const ports = z
    .array(z.object({ containerPort: z.number(), hostPort: z.number() }))
    .parse(info.configuration.publishedPorts);
  const port = ports.find((entry) => entry.containerPort === 5000)?.hostPort;
  if (!port) throw new Error("IntegreSQL has no published API port");
  return `http://localhost:${port}`;
}

/** Whether IntegreSQL answers and targets the shared server's current address. */
async function healthyIntegresql(postgresHost: string): Promise<boolean> {
  const integresql = await findContainer(INTEGRESQL);
  if (integresql?.status.state !== "running") return false;
  const [info] = JSON.parse(await containerCli(["inspect", INTEGRESQL]));
  const environment: string[] =
    info?.configuration?.initProcess?.environment ?? [];
  if (!environment.includes(`PGHOST=${postgresHost}`)) return false;
  try {
    const integresqlUrl = await integresqlAddress();
    // Generous: another worktree's suite may be loading it.
    await waitFor("IntegreSQL", () => httpReady(integresqlUrl), {
      timeoutMs: 15_000,
    });
    return true;
  } catch {
    console.log("[test-services] IntegreSQL is unhealthy");
    return false;
  }
}

async function integresqlDatabases(): Promise<string[]> {
  return (await psql(INTEGRESQL_DATABASES)).split("\n").filter(Boolean);
}

/** Recreate IntegreSQL empty; only when no live run uses it. */
async function createIntegresql(postgresHost: string): Promise<void> {
  const previousUrl = await integresqlAddress().catch(() => undefined);
  await stopAndRemove(INTEGRESQL);
  if (previousUrl) retireTemplateMarkers(previousUrl);
  const stale = await integresqlDatabases();
  if (stale.length > 0) {
    await psql(
      stale.flatMap((name) => [
        `ALTER DATABASE "${name}" WITH IS_TEMPLATE false`,
        `DROP DATABASE "${name}" WITH (FORCE)`,
      ]),
    );
    console.log(`[test-services] Dropped ${stale.length} IntegreSQL databases`);
  }
  const startedAt = Date.now();
  console.log(`[test-services] Starting ${INTEGRESQL}`);
  await containerCli(
    ["run", "--detach", "--name", INTEGRESQL, ...integresqlArgs(postgresHost)],
    180_000,
  );
  const integresqlUrl = await integresqlAddress();
  await waitFor("IntegreSQL", () => httpReady(integresqlUrl));
  logPhase("IntegreSQL ready", startedAt);
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
      z
        .array(z.object({ id: z.string() }))
        .parse(
          JSON.parse(await containerCli(["list", "--all", "--format", "json"])),
        )
        .map((entry) => entry.id),
      others,
      configuration,
    )) {
      if (name.endsWith("-integresql")) {
        const url = await integresqlAddress(name).catch(() => undefined);
        if (url) retireTemplateMarkers(url);
      }
      await stopAndRemove(name);
      console.log(`[test-services] Removed idle ${name}`);
    }
    await ensureSharedPostgres();
    await connectDockerPostgres();
    const postgresHost =
      devContainerBackend() === "apple"
        ? await containerAddress(SHARED_POSTGRES)
        : SHARED_POSTGRES;
    let healthy = await healthyIntegresql(postgresHost);
    const sharing = others.filter((run) => run.configuration === configuration);
    // Recreating IntegreSQL drops databases a live run is using; a transient
    // outage is the newcomer's failure, not a reason to reset.
    if (!healthy && sharing.length > 0)
      throw new Error(
        `Shared test services are unhealthy while live runs use them (${sharing
          .map((run) => `pid ${run.pid} in ${run.root}`)
          .join(", ")}); retry after they finish`,
      );
    if (
      healthy &&
      sharing.length === 0 &&
      (await integresqlDatabases()).length > RECYCLE_DATABASE_COUNT
    ) {
      console.log(
        `[test-services] Recycling idle ${INTEGRESQL} past ${RECYCLE_DATABASE_COUNT} databases`,
      );
      healthy = false;
    }
    if (!healthy) await createIntegresql(postgresHost);
    const integresqlUrl = await integresqlAddress();
    console.log(
      `[test-services] Ready: PostgreSQL ${postgresHost}:5432, IntegreSQL ${integresqlUrl}`,
    );
    const births = z
      .array(
        z.object({
          id: z.string(),
          status: z.object({ startedDate: z.string().min(1) }),
        }),
      )
      .parse(
        JSON.parse(
          await containerCli(["inspect", SHARED_POSTGRES, INTEGRESQL]),
        ),
      );
    const incarnation = createHash("sha256")
      .update(JSON.stringify(births))
      .digest("hex");
    retireTemplateMarkers(integresqlUrl, incarnation);
    const overlay: NodeJS.ProcessEnv = {
      CUBBY_TEMPLATE_SERVICE_ID: incarnation,
      CUBBY_TEST_SERVICES: "external",
      INTEGRESQL_URL: integresqlUrl,
      INTEGRESQL_DATABASE_HOST:
        devContainerBackend() === "apple" ? postgresHost : "localhost",
      INTEGRESQL_DATABASE_PORT:
        devContainerBackend() === "apple" ? "5432" : "55432",
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
      z
        .array(z.object({ id: z.string() }))
        .parse(
          JSON.parse(await containerCli(["list", "--all", "--format", "json"])),
        )
        .map((entry) => entry.id),
      live,
    )) {
      if (name.endsWith("-integresql")) {
        const url = await integresqlAddress(name).catch(() => undefined);
        if (url) retireTemplateMarkers(url);
      }
      await stopAndRemove(name);
      console.log(`[test-services] Removed ${name}`);
    }
    for (const run of live)
      console.log(
        `[test-services] Kept ${pairName(run.configuration, "integresql")} for live run ${run.pid} in ${run.root}`,
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
  const managed = serviceMode(env) === "managed" && !env.CI;
  // Managed commands keep their process group registered while services are in use.
  const detachedCommand = managed && platform !== "win32";
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
