import path from "node:path";
import { fileURLToPath } from "node:url";

import { holdHarnessLock } from "../../tooling/harness-lock";
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
  const release = process.argv.includes("--ui")
    ? async () => {}
    : await holdHarnessLock();
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
