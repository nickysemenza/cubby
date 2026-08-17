#!/usr/bin/env node
/**
 * Machine-wide concurrency limiter for expensive builds.
 *
 * This repo is routinely checked out into dozens of agent worktrees at once,
 * each free to start its own `tsc`/`vitest`/`vite`. Nothing bounded that, and
 * the cost is almost entirely contention rather than work: the same apps/web
 * typecheck measured 6.4s on an idle 8-core box and 97s at load ~215, with a
 * full monorepo run exceeding nine minutes at load ~400.
 *
 * So the slots live OUTSIDE any worktree (~/.cache/cubby/slots) — a per-worktree
 * lock would coordinate nothing, since the contention is between worktrees.
 *
 * Usage:  node scripts/with-slot.mjs <command> [args...]
 *
 * Env:
 *   CUBBY_SLOTS       concurrent holders allowed (default: max(2, cores/4))
 *   CUBBY_NO_SLOT=1   bypass entirely — set this in CI, where the runner is
 *                     single-tenant and serializing would only add wall-clock
 *   CUBBY_SLOT_TIMEOUT_MS  give up waiting and run anyway (default 600000)
 *
 * Nested calls pass straight through. `check` invokes `typecheck`, so without
 * that a single-slot machine would deadlock against itself — the outer command
 * holding the only slot while the inner one waits for it forever.
 */
import { spawn } from "node:child_process";
import { cpus, homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const SLOT_DIR = join(homedir(), ".cache", "cubby", "slots");
const SLOT_COUNT = Math.max(
  1,
  Number(process.env.CUBBY_SLOTS) || Math.max(2, Math.floor(cpus().length / 4)),
);
const TIMEOUT_MS = Number(process.env.CUBBY_SLOT_TIMEOUT_MS) || 600_000;

const [, , command, ...args] = process.argv;
if (!command) {
  console.error("with-slot: no command given");
  process.exit(2);
}

/** Is the process holding this slot still alive? */
function holderAlive(slotPath) {
  try {
    const pid = Number(readFileSync(join(slotPath, "pid"), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone. EPERM = alive but owned by another user; treat as alive
    // rather than stealing a slot we can't verify.
    return err?.code === "EPERM";
  }
}

/**
 * SIGKILL can't be trapped, so a hard-killed agent leaves its slot directory
 * behind forever. Without this the machine deadlocks after a few crashes —
 * which, with this many concurrent sessions, is a matter of when and not if.
 */
function reclaimIfStale(slotPath) {
  if (holderAlive(slotPath)) return false;
  try {
    rmSync(slotPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function tryAcquire() {
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slotPath = join(SLOT_DIR, `slot-${i}`);
    try {
      // mkdir is atomic on POSIX — this is the whole mutual-exclusion primitive.
      // (macOS ships no flock(1), and a lockfile written non-atomically would
      // race.) Losing the race throws EEXIST, which is the normal path.
      mkdirSync(slotPath, { recursive: false });
      writeFileSync(join(slotPath, "pid"), String(process.pid));
      return slotPath;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // Occupied — but possibly by a corpse. If we reclaim it, the retry below
      // races other waiters through mkdir, and exactly one of them wins.
      if (reclaimIfStale(slotPath)) {
        try {
          mkdirSync(slotPath, { recursive: false });
          writeFileSync(join(slotPath, "pid"), String(process.pid));
          return slotPath;
        } catch {
          /* another waiter beat us to it; keep scanning */
        }
      }
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire() {
  mkdirSync(SLOT_DIR, { recursive: true });
  const deadline = Date.now() + TIMEOUT_MS;
  let waited = false;
  while (Date.now() < deadline) {
    const slot = tryAcquire();
    if (slot) {
      if (waited) console.error(`with-slot: acquired after waiting`);
      return slot;
    }
    if (!waited) {
      console.error(
        `with-slot: all ${SLOT_COUNT} slots busy, waiting (CUBBY_NO_SLOT=1 to bypass)`,
      );
      waited = true;
    }
    // Jitter, so releasing one slot doesn't wake every waiter into the same
    // mkdir at the same instant.
    await sleep(200 + Math.floor(Math.random() * 300));
  }
  // A timeout must not fail the user's build — degrade to unslotted rather than
  // turning contention into a spurious red typecheck.
  console.error(
    `with-slot: timed out after ${TIMEOUT_MS}ms, running without a slot`,
  );
  return null;
}

function run(slotPath) {
  let released = false;
  const release = () => {
    if (released || !slotPath) return;
    released = true;
    try {
      rmSync(slotPath, { recursive: true, force: true });
    } catch {
      /* best effort — a leftover dir is reclaimed as stale next time */
    }
  };

  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, CUBBY_SLOT_HELD: "1" },
  });

  // Forward signals so Ctrl-C reaches the real work, not just this wrapper.
  const forward = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of forward) {
    process.on(sig, () => {
      if (!child.killed) child.kill(sig);
    });
  }
  process.on("exit", release);

  child.on("error", (err) => {
    release();
    console.error(`with-slot: failed to start ${command}: ${err.message}`);
    process.exit(127);
  });

  child.on("exit", (code, signal) => {
    release();
    if (signal) {
      // Re-raise so callers see a real signal death, not a synthesized code.
      process.kill(process.pid, signal);
      return;
    }
    // Propagating the child's exit code is load-bearing: swallowing it here
    // would make a failing typecheck look green to husky and to CI.
    process.exit(code ?? 1);
  });
}

if (process.env.CUBBY_NO_SLOT === "1" || process.env.CUBBY_SLOT_HELD === "1") {
  run(null);
} else {
  run(await acquire());
}
