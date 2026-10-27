import { prepareTemplate } from "#web/tooling/test-database-lease.ts";

/**
 * Prepare immutable inputs before Playwright starts isolated worker runtimes.
 * Workers serve the built Worker; Nx's build-cf (run by `pnpm test:e2e` and
 * the browser targets' `dependsOn`) keeps it current.
 */
async function globalSetup(): Promise<void> {
  console.log("[E2E Setup] Preparing shared PostgreSQL template...");
  const templateStart = performance.now();
  await prepareTemplate("browser");
  console.log(
    `[E2E Setup] Shared PostgreSQL template is ready ${Math.round(performance.now() - templateStart)}ms`,
  );
}

export default globalSetup;
