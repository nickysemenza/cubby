import lockfile from "proper-lockfile";

/**
 * Hold the machine-wide harness lock so two workerd or browser suites never
 * share the CPU; concurrent suites starve each other into timeouts. A child
 * of the current owner (`CUBBY_HARNESS_LOCK_OWNER` names a live process)
 * inherits the lock instead of waiting on its parent. Resolves to the release.
 */
export async function holdHarnessLock(): Promise<() => Promise<void>> {
  const priorOwner = process.env.CUBBY_HARNESS_LOCK_OWNER;
  if (ownerIsAlive(Number(priorOwner))) return async () => {};
  const releaseLock = await lockfile.lock("/tmp/cubby-harness", {
    realpath: false,
    // An owner rebuilds the Worker synchronously while holding the lock, which
    // blocks the refresh timer; a shorter threshold lets a second suite
    // reclaim a live owner's lock mid-build.
    stale: 10 * 60_000,
    update: 10_000,
    // Wait indefinitely, once a second. `retries: Infinity` throws a
    // RangeError inside the `retry` package; `forever` repeats the last delay.
    retries: { retries: 1, forever: true, minTimeout: 1000, maxTimeout: 1000 },
  });
  process.env.CUBBY_HARNESS_LOCK_OWNER = String(process.pid);
  return async () => {
    await releaseLock();
    if (priorOwner === undefined) delete process.env.CUBBY_HARNESS_LOCK_OWNER;
    else process.env.CUBBY_HARNESS_LOCK_OWNER = priorOwner;
  };
}

function ownerIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
