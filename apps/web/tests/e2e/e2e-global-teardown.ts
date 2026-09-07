import type { FullConfig } from "@playwright/test";

import "./e2e-runtime-state";

async function globalTeardown(_config: FullConfig): Promise<void> {
  console.log("[E2E Teardown] Cleaning up...");

  const harness = globalThis.__E2E_HARNESS__;
  const database = globalThis.__E2E_DATABASE__;

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

    await globalThis.__E2E_OBJECT_STORAGE__?.close();
    globalThis.__E2E_OBJECT_STORAGE__ = undefined;
    globalThis.__E2E_HARNESS__ = undefined;
    globalThis.__E2E_DATABASE__ = undefined;
    delete process.env.E2E_DATABASE_URL;
  }

  console.log("[E2E Teardown] Done");
}

export default globalTeardown;
