import type { FullConfig } from "@playwright/test";
import type { TestHarness } from "wrangler";

async function globalTeardown(_config: FullConfig): Promise<void> {
  console.log("[E2E Teardown] Cleaning up...");

  const harness = (globalThis as Record<string, unknown>).__E2E_HARNESS__ as
    | TestHarness
    | undefined;

  if (harness) {
    console.log("[E2E Teardown] Stopping Cloudflare test harness...");
    await harness.close();
    console.log("[E2E Teardown] Test harness stopped");
  }

  console.log("[E2E Teardown] Done");
}

export default globalTeardown;
