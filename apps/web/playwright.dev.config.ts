import { defineConfig, devices } from "@playwright/test";

import { discoverHmrSession } from "./tests/e2e/hmr-session";

/**
 * Optional lane against this checkout's running `pnpm dev` origin
 * (`pnpm --dir apps/web test:e2e:hmr`). It reuses the warm HMR session instead
 * of a built Worker and disposable database, so it is local iteration evidence
 * only; the exact-head CI suite stays the merge gate.
 *
 * Kernel fixtures run in this process against the session database, so the
 * process takes the session profile's own local environment — never the
 * synthetic acceptance defaults in playwright.config.ts.
 */
const { profile, session } = discoverHmrSession();
Object.assign(process.env, profile.vars, {
  E2E_DATABASE_URL: profile.databaseUrl,
});

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /\.hmr\.ts$/,
  outputDir: "./test-results/hmr",
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // One persistent runtime and database: run serially rather than contend.
  workers: 1,
  reporter: [
    ["line"],
    ["./tests/e2e/e2e-harness-reporter.ts", { lane: "hmr" }],
  ],
  // A route's first visit compiles its module graph on demand.
  expect: { timeout: 15_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: session.origin,
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
