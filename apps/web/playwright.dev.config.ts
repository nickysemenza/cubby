import { defineConfig, devices } from "@playwright/test";

/**
 * Optional lane against this checkout's running `pnpm dev` origin
 * (`pnpm --dir apps/web test:e2e:hmr`). It reuses the warm HMR session instead
 * of a built Worker and disposable database, so it is local iteration evidence
 * only; the exact-head CI suite stays the merge gate.
 *
 * The worker fixture discovers and binds the local environment before any
 * writes. Configuration inspection itself needs no running development session.
 */
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
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
