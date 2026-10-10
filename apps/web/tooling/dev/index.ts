import {
  devSessionSchema as sessionSchema,
  type DevSession as Session,
} from "./state";
import { localSimulatorServer } from "../../../../scripts/lib/simulator-server.ts";
import { devContainerBackend } from "../../../../scripts/lib/dev-container.ts";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  renameSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pollUntil } from "@cubby/shared/retry";
import { runOrThrow } from "../../../../scripts/lib/run.ts";
import { Pool } from "pg";
import { z } from "zod";
import {
  devProcessEnvironment,
  resolveDevProfile,
  type DevProfile,
} from "../../../../scripts/lib/dev-profile.ts";

const root = path.resolve(import.meta.dirname, "../../../..");
interface DiagnosticChecks {
  session: boolean;
  process: boolean;
  ready: boolean;
  diagnostic?: string;
  tools: Record<string, boolean>;
  database?: boolean | string;
}

function processIdentity(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
function sessionPath(profile: DevProfile): string {
  return path.join(profile.stateDir, "session.json");
}
function readSession(profile: DevProfile): Session | undefined {
  if (!existsSync(sessionPath(profile))) return undefined;
  const session = sessionSchema.parse(
    JSON.parse(readFileSync(sessionPath(profile), "utf8")),
  );
  if (
    session.id !== profile.id ||
    session.database !== profile.name ||
    session.stateDir !== profile.stateDir
  )
    throw new Error("Refusing session manifest for another checkout/database");
  if (!/^http:\/\/localhost:\d+$/u.test(session.origin))
    throw new Error("Refusing non-local session origin");
  return session;
}
function alive(session: Session): boolean {
  return (
    !!session.supervisorIdentity &&
    processIdentity(session.supervisorPid) === session.supervisorIdentity
  );
}
function writeSession(profile: DevProfile, session: Session): void {
  const destination = sessionPath(profile);
  writeFileSync(`${destination}.tmp`, `${JSON.stringify(session, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${destination}.tmp`, destination);
}
async function freePort(port: number, strict: boolean): Promise<number> {
  for (let candidate = port; candidate <= 65535; candidate++) {
    const available = (
      await Promise.all(
        ["127.0.0.1", "::1"].map(
          (host) =>
            new Promise<boolean>((resolve) => {
              const server = net.createServer();
              server.once("error", (error: NodeJS.ErrnoException) =>
                resolve(error.code === "EADDRNOTAVAIL"),
              );
              server.listen(candidate, host, () =>
                server.close(() => resolve(true)),
              );
            }),
        ),
      )
    ).every(Boolean);
    if (available) return candidate;
    if (strict)
      throw new Error(`Port ${port} is occupied; choose another explicit port`);
  }
  throw new Error("No local port available");
}
const ownedChildren = new Set<ChildProcess>();
let cancelled = false;
let supervising = false;
function terminateOwnedChildren(): void {
  cancelled = true;
  for (const child of ownedChildren) {
    if (child.exitCode !== null || !child.pid) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* Already exited. */
    }
  }
}

async function run(
  profile: DevProfile,
  command: string,
  args: string[],
  extra: Record<string, string> = {},
): Promise<void> {
  await runOrThrow(command, args, {
    cwd: profile.repoRoot,
    env: { ...devProcessEnvironment(profile), ...extra },
    stdio: "inherit",
    detached: supervising,
    describe: (status) => `${command} ${args[0]} exited ${status}`,
    onSpawn: (child) => ownedChildren.add(child),
    onClose: (child) => ownedChildren.delete(child),
  });
}
function installEnvironment(profile: DevProfile): void {
  const safe = devProcessEnvironment(profile);
  for (const key of Object.keys(process.env))
    if (!(key in safe)) delete process.env[key];
  Object.assign(process.env, safe);
}
async function readiness(session: Session) {
  const response = await fetch(`${session.origin}/__dev/ready`, {
    signal: AbortSignal.timeout(3_000),
  });
  const body = z
    .object({ devId: z.string(), database: z.string(), ready: z.boolean() })
    .passthrough()
    .parse(await response.json());
  if (body.devId !== session.id || body.database !== session.database)
    throw new Error("Runtime identity differs from session manifest");
  if (!response.ok || !body.ready)
    throw new Error(`Runtime is not ready (${response.status})`);
  return body;
}
/** Wait up to `timeoutMs` for `isAlive` to turn false; the caller re-checks and decides. */
const untilGone = (isAlive: () => boolean, timeoutMs: number) =>
  pollUntil(() => (isAlive() ? undefined : true), {
    label: "process exit",
    timeoutMs,
    intervalMs: 100,
  }).catch(() => undefined);

async function stop(profile: DevProfile): Promise<void> {
  const session = readSession(profile);
  if (!session) return;
  if (alive(session)) process.kill(session.supervisorPid, "SIGTERM");
  await untilGone(() => alive(session), 5000);
  if (alive(session))
    throw new Error(
      "Development supervisor did not stop; persistent data retained",
    );
  const runtimeAlive = () =>
    !!session.runtimePid &&
    !!session.runtimeIdentity &&
    processIdentity(session.runtimePid) === session.runtimeIdentity;
  if (runtimeAlive() && session.runtimePid) {
    process.kill(-session.runtimePid, "SIGTERM");
    await untilGone(runtimeAlive, 5000);
    if (runtimeAlive()) {
      process.kill(-session.runtimePid, "SIGKILL");
      await untilGone(runtimeAlive, 2000);
    }
    if (runtimeAlive())
      throw new Error("Owned runtime did not stop; persistent data retained");
  }
  session.readiness = "stopped";
  writeSession(profile, session);
}
function printLinks(session: Session): void {
  console.log(
    `[dev] ${session.profile}: ${session.origin}\n[dev] Login: ${session.origin}/__dev/login\n[dev] Explorer: ${session.explorerURL}\n[dev] Inspector: ${session.inspectorURL}\n[dev] Postgres: localhost:55432/${session.database}\n[dev] Discovery: ${session.stateDir}/session.json`,
  );
}

async function start(profile: DevProfile, preview: boolean): Promise<void> {
  if (preview && profile.profile === "integrations")
    throw new Error(
      "Integration peers run under Vite HMR; use pnpm dev:integrations. Built preview currently supports the offline profile.",
    );
  cancelled = false;
  const previous = readSession(profile);
  const mode = preview ? "preview" : "development";
  if (previous && alive(previous)) {
    if (previous.profile !== profile.profile)
      throw new Error(
        "Stop the current development session before changing profiles",
      );
    if (previous.mode !== mode)
      throw new Error(
        "Stop the current development session before changing between HMR and built preview",
      );
    await readiness(previous);
    printLinks(previous);
    return;
  }
  if (previous) await stop(profile);
  const port = await freePort(profile.port, !!process.env.PORT);
  const inspectorPort = await freePort(
    profile.inspectorPort,
    !!process.env.CUBBY_DEV_INSPECTOR_PORT,
  );
  const selectedEnvironment = {
    ...process.env,
    PORT: String(port),
    CUBBY_DEV_INSPECTOR_PORT: String(inspectorPort),
  };
  for (const key of [
    "APP_ORIGIN",
    "BETTER_AUTH_URL",
    "R2_ENDPOINT",
    "R2_PUBLIC_URL",
  ])
    Reflect.deleteProperty(selectedEnvironment, key);
  profile = resolveDevProfile(root, selectedEnvironment);
  mkdirSync(profile.stateDir, { recursive: true });
  let child: ChildProcess | undefined;
  let interrupted = false;
  const session: Session = {
    schemaVersion: 1,
    id: profile.id,
    profile: profile.profile,
    mode,
    origin: profile.origin,
    database: profile.name,
    stateDir: profile.stateDir,
    supervisorPid: process.pid,
    supervisorIdentity: processIdentity(process.pid),
    startedAt: new Date().toISOString(),
    readiness: "starting",
    explorerURL: `${profile.origin}/cdn-cgi/local/explorer`,
    inspectorURL: `http://localhost:${profile.inspectorPort}`,
    phases: {},
  };
  writeSession(profile, session);
  const signal = () => {
    interrupted = true;
    terminateOwnedChildren();
  };
  supervising = true;
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  const phase = async (name: string, operation: () => Promise<void>) => {
    if (cancelled) throw new Error("Development startup cancelled");
    const started = performance.now();
    await operation();
    if (cancelled) throw new Error("Development startup cancelled");
    session.phases[name] = Math.round(performance.now() - started);
    writeSession(profile, session);
  };
  try {
    await phase("database", () =>
      run(profile, process.execPath, ["scripts/dev-db.ts", "ready"]),
    );
    await phase("wasm", () =>
      run(profile, process.execPath, ["scripts/ensure-wasm.ts"]),
    );
    await phase("generator", () =>
      run(profile, process.execPath, ["scripts/generator/ensure.ts"]),
    );
    await phase("mcpAssets", () =>
      run(profile, "pnpm", ["exec", "nx", "run", "@cubby/mcp-apps:build"]),
    );
    if (preview)
      await phase("build", async () => {
        await run(
          profile,
          "pnpm",
          ["--dir", profile.webRoot, "run", "build:cf"],
          { CUBBY_DEV_PREVIEW_BUILD: "true" },
        );
        const builtRoot = path.join(profile.webRoot, "dist/server");
        const config = z
          .object({
            main: z.string(),
            assets: z.object({ directory: z.string() }).passthrough(),
          })
          .passthrough()
          .parse(
            JSON.parse(
              readFileSync(path.join(builtRoot, "wrangler.json"), "utf8"),
            ),
          );
        config.main = path.resolve(builtRoot, config.main);
        config.assets.directory = path.resolve(
          builtRoot,
          config.assets.directory,
        );
        writeFileSync(
          path.join(profile.stateDir, "config/preview.json"),
          JSON.stringify(config),
        );
      });
    const args = preview
      ? [
          "exec",
          "wrangler",
          "dev",
          "--config",
          path.join(profile.stateDir, "config/preview.json"),
          "--port",
          String(profile.port),
          "--inspector-port",
          String(profile.inspectorPort),
          "--local",
          "--persist-to",
          path.join(profile.stateDir, "cloudflare"),
        ]
      : ["exec", "vite", "dev"];
    child = spawn("pnpm", args, {
      cwd: profile.webRoot,
      env: devProcessEnvironment(profile),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    ownedChildren.add(child);
    child.once("close", () => ownedChildren.delete(child!));
    child.on("error", () => {
      interrupted = true;
    });
    let logs = "";
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => {
        const text = String(chunk);
        logs = (logs + text).slice(-64_000);
        process.stdout.write(text);
        writeFileSync(path.join(profile.stateDir, "runtime.log"), logs, {
          mode: 0o600,
        });
      });
    session.runtimePid = child.pid;
    session.runtimeIdentity = child.pid
      ? processIdentity(child.pid)
      : undefined;
    writeSession(profile, session);
    await phase("runtime", async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 180; attempt++) {
        if (interrupted || child?.exitCode !== null)
          throw new Error("Worker exited before readiness");
        try {
          const response = await fetch(`${profile.origin}/__dev/health`, {
            signal: AbortSignal.timeout(3_000),
          });
          const body = z
            .object({ devId: z.string(), database: z.string() })
            .parse(await response.json());
          if (
            !response.ok ||
            body.devId !== profile.id ||
            body.database !== profile.name
          )
            throw new Error("Worker health identity mismatch");
          return;
        } catch (error) {
          lastError = error;
          await delay(500);
        }
      }
      throw new Error(`Worker did not become healthy: ${String(lastError)}`);
    });
    await phase("application", async () => {
      const response = await fetch(`${profile.origin}/api/auth/get-session`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok)
        throw new Error(
          `Local application initialization failed (${response.status}): ${await response.text()}`,
        );
    });
    await phase("fixtures", async () => {
      const { seedDevDatabase } = await import("./fixtures.ts");
      installEnvironment(profile);
      await seedDevDatabase({
        databaseUrl: profile.databaseUrl,
        baseURL: profile.origin,
        pack: "core",
      });
    });
    await phase("readiness", async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await readiness(session);
          return;
        } catch (error) {
          if (cancelled || child?.exitCode !== null || attempt >= 9)
            throw error;
          await delay(500);
        }
      }
    });
    session.readiness = "ready";
    writeSession(profile, session);
    printLinks(session);
    console.log(`[dev] Startup phases (ms): ${JSON.stringify(session.phases)}`);
    await new Promise<void>((resolve, reject) => {
      if (child?.exitCode !== null)
        return reject(new Error("Worker exited during startup"));
      child?.once("close", (code) =>
        interrupted || code === 0
          ? resolve()
          : reject(
              new Error(
                `Worker exited ${code}; see ${profile.stateDir}/runtime.log`,
              ),
            ),
      );
    });
    session.readiness = "stopped";
  } catch (error) {
    session.readiness = interrupted ? "stopped" : "failed";
    throw error;
  } finally {
    signal();
    await Promise.all(
      [...ownedChildren].map(
        (owned) =>
          new Promise<void>((resolve) => {
            if (owned.exitCode !== null) return resolve();
            const timeout = setTimeout(() => {
              if (owned.pid) {
                try {
                  process.kill(-owned.pid, "SIGKILL");
                } catch {
                  /* Already exited. */
                }
              }
              resolve();
            }, 3_000);
            owned.once("close", () => {
              clearTimeout(timeout);
              resolve();
            });
          }),
      ),
    );
    writeSession(profile, session);
    process.removeListener("SIGINT", signal);
    process.removeListener("SIGTERM", signal);
  }
}

async function diagnostics(
  profile: DevProfile,
  session: Session | undefined,
  command: string,
  json: boolean,
): Promise<void> {
  const checks: DiagnosticChecks = {
    session: !!session,
    process: !!session && alive(session),
    ready: false,
    tools: {},
  };
  try {
    if (!session || !alive(session))
      throw new Error("No live development session");
    await readiness(session);
    checks.ready = true;
  } catch (error) {
    checks.ready = false;
    checks.diagnostic = String(error);
  }
  if (command === "doctor") {
    for (const tool of [
      "node",
      "pnpm",
      devContainerBackend() === "docker" ? "docker" : "container",
    ]) {
      try {
        execFileSync(tool, ["--version"], { stdio: "ignore" });
        checks.tools[tool] = true;
      } catch {
        checks.tools[tool] = false;
      }
    }
    const pool = new Pool({
      connectionString: profile.databaseUrl,
      connectionTimeoutMillis: 3_000,
    });
    try {
      await pool.query("SELECT 1");
      checks.database = true;
    } catch (error) {
      checks.database = String(error);
    } finally {
      await pool.end();
    }
  }
  console.log(
    JSON.stringify(
      { schemaVersion: 1, checks, session: session ?? null },
      null,
      json ? undefined : 2,
    ),
  );
  if (
    !checks.ready ||
    Object.values(checks.tools).some((value) => !value) ||
    (checks.database !== undefined && checks.database !== true)
  )
    process.exitCode = 1;
  return;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const command = args[0] ?? "start";
  const json = args.includes("--json");
  const profile = resolveDevProfile(root);
  if (command === "start" || command === "preview")
    return start(profile, command === "preview");
  if (command === "down") return stop(profile);
  if (command === "reset") {
    await stop(profile);
    await run(profile, process.execPath, ["scripts/dev-db.ts", "reset"]);
    rmSync(path.join(profile.stateDir, "cloudflare"), {
      recursive: true,
      force: true,
    });
    console.log(
      "[dev] This checkout's database and Worker state reset. Start pnpm dev to seed.",
    );
    return;
  }
  const session = readSession(profile);
  if (command === "status" || command === "doctor")
    return diagnostics(profile, session, command, json);
  if (!session || !alive(session)) throw new Error("Start pnpm dev first");
  await readiness(session);
  if (command === "sim") {
    return launchLocalDevSimulator(session.origin, args.slice(1));
  }
  if (command === "seed") {
    installEnvironment({
      ...profile,
      origin: session.origin,
      vars: {
        ...profile.vars,
        APP_ORIGIN: session.origin,
        BETTER_AUTH_URL: session.origin,
        R2_ENDPOINT: `${session.origin}/__local-storage/s3`,
        R2_PUBLIC_URL: session.origin,
      },
    });
    const { seedDevDatabase, devFixturePackSchema } =
      await import("./fixtures.ts");
    return seedDevDatabase({
      databaseUrl: profile.databaseUrl,
      baseURL: session.origin,
      pack: devFixturePackSchema.parse(args[1] ?? "core"),
    });
  }
  throw new Error(`Unknown dev command: ${command}`);
}

if (process.argv[1] === import.meta.filename)
  main().catch((error) => {
    if (process.argv.includes("--json"))
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          checks: { ready: false, diagnostic: String(error) },
          session: null,
        }),
      );
    else console.error(`[dev] ${String(error)}`);
    process.exitCode = 1;
  });

async function launchLocalDevSimulator(
  origin: string,
  args: readonly string[] = [],
): Promise<void> {
  const server = localSimulatorServer(origin);
  if (args.includes("--server"))
    throw new Error(
      "The development session selects the simulator server; omit --server.",
    );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "apple",
        "sim",
        "--server",
        server,
        ...args.filter((arg) => arg !== "--"),
      ],
      {
        cwd: path.resolve(import.meta.dirname, "../../../.."),
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`Local simulator launch failed (${signal ?? code}).`),
          ),
    );
  });
}
