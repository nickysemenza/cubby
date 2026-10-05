import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";

/**
 * Machine-wide lock serializing workerd-backed suites (the coupled Workers
 * harness, Playwright E2E). Two such suites at once starve each other of CPU
 * into 15-20s wait timeouts. The path is fixed in /tmp, not os.tmpdir(), so
 * every checkout on the machine shares it.
 */
const lockDir = () =>
  process.env.CUBBY_HARNESS_LOCK_DIR ?? "/tmp/cubby-harness.lock";
/** Set by the holder so the processes it spawns pass straight through. */
const OWNER_ENV = "CUBBY_HARNESS_LOCK_OWNER";

const ownerSchema = z.object({
  pid: z.number().int(),
  label: z.string(),
  cwd: z.string(),
  startedAt: z.string(),
});
type Owner = z.infer<typeof ownerSchema>;
const errorCode = (error: unknown) =>
  z.object({ code: z.string() }).safeParse(error).data?.code;

let held = 0;
let acquiring: Promise<void> | undefined;
let exitHookInstalled = false;

function readOwner(dir: string): Owner | undefined {
  try {
    return ownerSchema.parse(
      JSON.parse(readFileSync(path.join(dir, "owner.json"), "utf8")),
    );
  } catch {
    // Missing or half-written: treated as an owner we cannot identify.
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function releaseNow(dir: string) {
  if (readOwner(dir)?.pid === process.pid)
    rmSync(dir, { recursive: true, force: true });
  if (process.env[OWNER_ENV] === String(process.pid))
    delete process.env[OWNER_ENV];
}

/**
 * Remove a dead owner's lock. Only one waiter reclaims at a time, and it
 * re-reads the owner under that mutex, so a waiter that saw the same dead
 * owner never removes the lock a faster waiter has since taken.
 */
function reclaim(dir: string, dead: Owner, log: (line: string) => void) {
  const mutex = `${dir}.reclaim`;
  try {
    mkdirSync(mutex);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    // A reclaimer that died mid-reclaim would otherwise block every waiter.
    const stat = statSync(mutex, { throwIfNoEntry: false });
    if (stat && Date.now() - stat.mtimeMs > 10_000)
      rmSync(mutex, { recursive: true, force: true });
    return;
  }
  try {
    if (readOwner(dir)?.pid !== dead.pid || alive(dead.pid)) return;
    rmSync(dir, { recursive: true, force: true });
    log(
      `[harness-lock] reclaimed ${dir} from exited pid ${dead.pid} (${dead.label})`,
    );
  } finally {
    rmSync(mutex, { recursive: true, force: true });
  }
}

/**
 * Wait for the machine-wide harness lock, then hold it until the returned
 * release runs or this process exits. Nested calls in the holder, and calls
 * from processes it spawned, share the hold instead of queueing behind it.
 */
export async function acquireHarnessLock(
  label: string,
  {
    pollMs = 1000,
    logEveryMs = 30_000,
    // Straight to stderr: Vitest's `silent: "passed-only"` swallows console
    // output, and a queued suite must still say what it is waiting for.
    log = (line: string) => process.stderr.write(`${line}\n`),
  }: {
    pollMs?: number;
    logEveryMs?: number;
    log?: (line: string) => void;
  } = {},
): Promise<() => void> {
  const dir = lockDir();
  const inherited = process.env[OWNER_ENV];
  if (
    held === 0 &&
    inherited !== undefined &&
    inherited !== String(process.pid) &&
    readOwner(dir)?.pid === Number(inherited)
  )
    return () => {};
  for (;;) {
    if (held > 0) {
      held += 1;
      return releaseOnce();
    }
    // Another call in this process is already queued: share its hold rather
    // than queueing behind this process's own lock.
    if (!acquiring) {
      acquiring = waitForLock(dir, label, pollMs, logEveryMs, log);
      try {
        await acquiring;
      } finally {
        acquiring = undefined;
      }
      return releaseOnce();
    }
    await acquiring.catch(() => {});
  }

  function releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held -= 1;
      if (held === 0) releaseNow(dir);
    };
  }
}

/** Poll until this process owns the lock directory; leaves `held` at 1. */
async function waitForLock(
  dir: string,
  label: string,
  pollMs: number,
  logEveryMs: number,
  log: (line: string) => void,
): Promise<void> {
  const waitingSince = Date.now();
  let lastLog = -Infinity;
  for (;;) {
    try {
      mkdirSync(dir);
      const owner: Owner = {
        pid: process.pid,
        label,
        cwd: process.cwd(),
        startedAt: new Date().toISOString(),
      };
      writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner));
      held = 1;
      process.env[OWNER_ENV] = String(process.pid);
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.once("exit", () => {
          if (held > 0) releaseNow(dir);
        });
      }
      if (lastLog > -Infinity)
        log(
          `[harness-lock] acquired ${dir} for ${label} after ${Math.round((Date.now() - waitingSince) / 1000)}s`,
        );
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const owner = readOwner(dir);
    if (owner && !alive(owner.pid)) {
      reclaim(dir, owner, log);
      continue;
    }
    if (Date.now() - lastLog >= logEveryMs) {
      lastLog = Date.now();
      log(
        owner
          ? `[harness-lock] ${label} waiting for ${dir}: held by pid ${owner.pid} (${owner.label}) in ${owner.cwd} since ${owner.startedAt}`
          : `[harness-lock] ${label} waiting for ${dir}: no owner record (a hand-made lock); \`rmdir ${dir}\` if no harness run is active`,
      );
    }
    await pause(pollMs);
  }
}
