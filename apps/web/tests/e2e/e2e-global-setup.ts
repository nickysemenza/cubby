import path from "node:path";
import lockfile from "proper-lockfile";
import { fileURLToPath } from "node:url";

import { prepareTemplate } from "../../tooling/test-database-lease";
import { webBuildNeedsBuild } from "../../tooling/web-build-provenance";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Prepare immutable inputs before Playwright starts isolated worker runtimes.
 * A run holds the machine-wide harness lock until it ends (the returned
 * teardown), so it never shares the CPU with another workerd suite. A
 * persistent `--ui` session keeps global setup alive while idle, so it would
 * hold the lock indefinitely; it skips the lock instead.
 */
async function globalSetup(): Promise<() => void | Promise<void>> {
  const priorOwner = process.env.CUBBY_HARNESS_LOCK_OWNER;
  const ownerPid = Number(priorOwner);
  let inheritedOwner = false;
  if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
    try {
      process.kill(ownerPid, 0);
      inheritedOwner = true;
    } catch (error) {
      inheritedOwner =
        error instanceof Error && "code" in error && error.code === "EPERM";
    }
  }
  const releaseLock =
    process.argv.includes("--ui") || inheritedOwner
      ? undefined
      : await lockfile.lock("/tmp/cubby-harness", {
          realpath: false,
          stale: 30_000,
          update: 10_000,
          retries: {
            retries: Number.POSITIVE_INFINITY,
            minTimeout: 1000,
            maxTimeout: 1000,
          },
        });
  if (releaseLock) process.env.CUBBY_HARNESS_LOCK_OWNER = String(process.pid);
  const release = async () => {
    if (releaseLock) await releaseLock();
    if (releaseLock) {
      if (priorOwner === undefined) delete process.env.CUBBY_HARNESS_LOCK_OWNER;
      else process.env.CUBBY_HARNESS_LOCK_OWNER = priorOwner;
    }
  };
  try {
    // Workers start the built bundle; a stale one fails here, once.
    webBuildNeedsBuild(path.join(__dirname, "../../../.."), true);

    console.log("[E2E Setup] Preparing shared PostgreSQL template...");
    const templateStart = performance.now();
    await prepareTemplate("browser");
    console.log(
      `[E2E Setup] Shared PostgreSQL template is ready ${Math.round(performance.now() - templateStart)}ms`,
    );
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

export default globalSetup;
