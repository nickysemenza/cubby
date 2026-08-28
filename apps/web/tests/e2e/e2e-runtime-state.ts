import type { TestHarness } from "wrangler";

import type { E2EDatabase } from "./e2e-database";

declare global {
  /** Process-local resources shared by Playwright setup, reporters, and teardown. */
  var __E2E_HARNESS__: TestHarness | undefined;
  var __E2E_DATABASE__: E2EDatabase | undefined;
}
