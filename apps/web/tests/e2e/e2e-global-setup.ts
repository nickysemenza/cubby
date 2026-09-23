import { prepareE2EDatabaseTemplate } from "./e2e-database";
import { prepareE2EWranglerConfig } from "./e2e-worker-config";

/** Prepare immutable inputs before Playwright starts isolated worker runtimes. */
async function globalSetup(): Promise<void> {
  prepareE2EWranglerConfig();

  console.log("[E2E Setup] Preparing shared PostgreSQL template...");
  const templateStart = performance.now();
  await prepareE2EDatabaseTemplate();
  console.log(
    `[E2E Setup] Shared PostgreSQL template is ready ${Math.round(performance.now() - templateStart)}ms`,
  );
}

export default globalSetup;
