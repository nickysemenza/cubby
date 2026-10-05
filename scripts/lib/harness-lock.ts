import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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

/** Move a dead owner's lock aside; restore it if a live owner won the race. */
function reclaim(dir: string, dead: Owner, log: (line: string) => void) {
  const tomb = `${dir}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(dir, tomb);
  } catch {
    return;
  }
  if (readOwner(tomb)?.pid !== dead.pid) {
    try {
      renameSync(tomb, dir);
    } catch {
      // The new owner's directory is gone either way; it will notice no lock.
    }
    return;
  }
  rmSync(tomb, { recursive: true, force: true });
  log(
    `[harness-lock] reclaimed ${dir} from exited pid ${dead.pid} (${dead.label})`,
  );
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
  if (held > 0) {
    held += 1;
    return releaseOnce();
  }

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
      process.once("exit", () => {
        if (held > 0) releaseNow(dir);
      });
      if (lastLog > -Infinity)
        log(
          `[harness-lock] acquired ${dir} for ${label} after ${Math.round((Date.now() - waitingSince) / 1000)}s`,
        );
      return releaseOnce();
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
