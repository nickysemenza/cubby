import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { Plugin } from "vite";

const execFileAsync = promisify(execFile);

const minutes = (value: string | undefined, fallback: number) =>
  value === undefined || value === "" ? fallback : Number(value);

/** `CUBBY_DEV_IDLE_MINUTES=0` keeps an idle development runtime alive. */
export const devIdleMs = () =>
  minutes(process.env.CUBBY_DEV_IDLE_MINUTES, 30) * 60_000;

/** `CUBBY_DEV_MEMORY_LIMIT_MB=0` disables the runtime memory restart. */
export const devMemoryLimitBytes = () =>
  minutes(process.env.CUBBY_DEV_MEMORY_LIMIT_MB, 1536) * 1024 * 1024;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * Ends a supervised `vite dev` runtime that nobody is using. Activity is an
 * HTTP request or a watched file change; an open HMR socket alone is not, since
 * forgotten preview panes and test browsers hold one indefinitely. Idle asks
 * the supervisor to stop so the session manifest records it. A runtime whose
 * supervisor was SIGKILLed has no one left to stop it, so it closes itself.
 */
export function devLifecycle(): Plugin {
  return {
    name: "cubby-dev-lifecycle",
    apply: "serve",
    configureServer(server) {
      const supervisorPid = Number(process.env.CUBBY_DEV_SUPERVISOR_PID);
      const sessionFile = process.env.CUBBY_DEV_SESSION_FILE;
      if (!supervisorPid || !sessionFile) return;
      // Startup phases such as fixture seeding run without HTTP traffic; the
      // idle clock starts only once the supervisor reports the session ready.
      const ready = () => {
        try {
          return /"readiness":\s*"ready"/u.test(
            readFileSync(sessionFile, "utf8"),
          );
        } catch {
          return false;
        }
      };
      const idleMs = devIdleMs();
      let lastActivity = Date.now();
      const touch = () => {
        lastActivity = Date.now();
      };
      server.middlewares.use((_req, _res, next) => {
        touch();
        next();
      });
      server.watcher.on("all", touch);
      let closing = false;
      const timer = setInterval(() => {
        if (closing) return;
        if (!processAlive(supervisorPid)) {
          closing = true;
          server.config.logger.warn(
            "[dev] Supervisor exited; closing the orphaned runtime",
          );
          // Closing disposes Miniflare, which stops its workerd children.
          const exit = () => process.exit(0);
          setTimeout(exit, 10_000).unref();
          void server.close().finally(exit);
          return;
        }
        if (idleMs <= 0) return;
        if (!ready()) {
          touch();
          return;
        }
        if (Date.now() - lastActivity > idleMs) {
          closing = true;
          server.config.logger.warn(
            `[dev] No requests or file changes for ${idleMs / 60_000} min; stopping. pnpm dev starts it again.`,
          );
          process.kill(supervisorPid, "SIGTERM");
        }
      }, 15_000);
      timer.unref();
      server.httpServer?.once("close", () => clearInterval(timer));
    },
  };
}

const units = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as const;

/**
 * Physical footprint of every process in a process group. On macOS this
 * includes compressed pages: a leaking runtime under memory pressure showed
 * 20 MB resident while holding 5 GB, so resident size alone hides the leak.
 */
export async function processGroupFootprint(pgid: number): Promise<number> {
  const { stdout: table } = await execFileAsync("ps", ["-axo", "pid=,pgid="]);
  const pids = table
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter(([, group]) => group === pgid)
    .map(([pid]) => pid!);
  if (pids.length === 0) return 0;
  if (process.platform !== "darwin") {
    const { stdout } = await execFileAsync("ps", [
      "-o",
      "rss=",
      "-p",
      pids.join(","),
    ]);
    return stdout
      .trim()
      .split("\n")
      .reduce((sum, kb) => sum + Number(kb) * 1024, 0);
  }
  const { stdout } = await execFileAsync("top", [
    "-l",
    "1",
    "-stats",
    "pid,mem",
    ...pids.flatMap((pid) => ["-pid", String(pid)]),
  ]);
  let total = 0;
  for (const line of stdout.split("\n")) {
    const match = /^\d+\s+(\d+(?:\.\d+)?)([BKMG])\+?\s*$/u.exec(line.trim());
    const unit = match?.[2];
    if (unit === "B" || unit === "K" || unit === "M" || unit === "G")
      total += Number(match?.[1]) * units[unit];
  }
  return total;
}
