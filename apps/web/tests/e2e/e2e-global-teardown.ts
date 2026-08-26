import type { FullConfig } from "@playwright/test";
import type { TestHarness } from "wrangler";
import type { E2EDatabase } from "./e2e-database";

async function globalTeardown(_config: FullConfig): Promise<void> {
  console.log("[E2E Teardown] Cleaning up...");

  const harness = (globalThis as Record<string, unknown>).__E2E_HARNESS__ as
    | TestHarness
    | undefined;
  const database = (globalThis as Record<string, unknown>).__E2E_DATABASE__ as
    | E2EDatabase
    | undefined;

  try {
    if (harness) {
      console.log("[E2E Teardown] Stopping Cloudflare test harness...");
      await harness.close();
      console.log("[E2E Teardown] Test harness stopped");
    }
  } finally {
    if (database) {
      console.log(`[E2E Teardown] Stopping ${database.kind} database...`);
      await database.close();
      console.log("[E2E Teardown] Database stopped");
    }

    delete (globalThis as Record<string, unknown>).__E2E_HARNESS__;
    delete (globalThis as Record<string, unknown>).__E2E_DATABASE__;
    delete process.env.E2E_DATABASE_URL;
  }

  console.log("[E2E Teardown] Done");
}

export default globalTeardown;
