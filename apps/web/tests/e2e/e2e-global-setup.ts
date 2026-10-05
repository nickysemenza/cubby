import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireHarnessLock } from "../../../../scripts/lib/harness-lock.ts";
import { writeLocalWorkerdConfig } from "../../tooling/e2e-worker-config";
import { prepareTemplate } from "../../tooling/test-database-lease";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Prepare immutable inputs before Playwright starts isolated worker runtimes.
 * A run holds the machine-wide harness lock until it ends (the returned
 * teardown), so it never shares the CPU with another workerd suite. A
 * persistent `--ui` session keeps global setup alive while idle, so it would
 * hold the lock indefinitely; it skips the lock instead.
 */
async function globalSetup(): Promise<() => void> {
  const release = process.argv.includes("--ui")
    ? () => {}
    : await acquireHarnessLock("Playwright E2E");
  const webRoot = path.join(__dirname, "../..");
  writeLocalWorkerdConfig(webRoot);

  console.log("[E2E Setup] Preparing shared PostgreSQL template...");
  const templateStart = performance.now();
  await prepareTemplate("browser");
  console.log(
    `[E2E Setup] Shared PostgreSQL template is ready ${Math.round(performance.now() - templateStart)}ms`,
  );
  return release;
}

export default globalSetup;
