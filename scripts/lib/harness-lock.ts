import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

/** This checkout's root; worktrees of one repository differ here. */
export const worktreeRoot = realpathSync(
  path.resolve(import.meta.dirname, "../.."),
);

const worktreeId = createHash("sha256")
  .update(worktreeRoot)
  .digest("hex")
  .slice(0, 12);

interface HarnessLock {
  /** `proper-lockfile` target; the held lock is the `<path>.lock` directory. */
  path: string;
  label: string;
  /**
   * Names the holder's PID for its children, which pass through instead of
   * waiting on their own parent. Omitted: a lock children never take.
   */
  ownerVariable?: string;
  /** How long an unrefreshed lock survives its holder; default 10 minutes. */
  staleMs?: number;
}

/**
 * Serializes this checkout's workerd and browser suites, which share its
 * built Worker (a stale one is rebuilt in place) and its CPU budget. Other
 * worktrees hold their own and run concurrently.
 */
export const WORKTREE_HARNESS_LOCK: HarnessLock = {
  path: `/tmp/cubby-harness-${worktreeId}`,
  label: "worktree harness",
  ownerVariable: "CUBBY_HARNESS_LOCK_OWNER",
};

/** Machine-wide: every worktree drives the same simulators. */
export const NATIVE_DEVICE_LOCK: HarnessLock = {
  path: "/tmp/cubby-native-device",
  label: "native device",
  ownerVariable: "CUBBY_NATIVE_DEVICE_LOCK_OWNER",
};

/**
 * Hold `lock` until the returned release, waiting indefinitely for another
 * holder; `proper-lockfile` refreshes it while held and reclaims it from an
 * interrupted process.
 */
export async function holdLock(
  lock: HarnessLock,
): Promise<() => Promise<void>> {
  const ownerVariable = lock.ownerVariable;
  const priorOwner = ownerVariable ? process.env[ownerVariable] : undefined;
  if (ownerIsAlive(Number(priorOwner))) return async () => {};
  const options = {
    realpath: false,
    // An owner rebuilds the Worker synchronously while holding the worktree
    // lock, which blocks the refresh timer; a shorter threshold lets a second
    // suite reclaim a live owner's lock mid-build.
    stale: lock.staleMs ?? 10 * 60_000,
    update: Math.min(10_000, (lock.staleMs ?? 10 * 60_000) / 2),
  };
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await lockfile.lock(lock.path, { ...options, retries: 0 });
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ELOCKED")
    )
      throw error;
    console.log(
      `[harness] Waiting for the ${lock.label} lock (${lock.path}.lock)`,
    );
    releaseLock = await lockfile.lock(lock.path, {
      ...options,
      // `retries: Infinity` throws a RangeError inside the `retry` package;
      // `forever` repeats the last delay.
      retries: {
        retries: 1,
        forever: true,
        minTimeout: 1000,
        maxTimeout: 1000,
      },
    });
  }
  if (ownerVariable) process.env[ownerVariable] = String(process.pid);
  return async () => {
    await releaseLock();
    if (!ownerVariable) return;
    if (priorOwner === undefined) delete process.env[ownerVariable];
    else process.env[ownerVariable] = priorOwner;
  };
}

export function ownerIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
