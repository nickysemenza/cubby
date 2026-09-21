import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import { resolveE2EWorkers } from "./tooling/e2e-workers";

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env") });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests/e2e",
  /* Public-repository ubuntu-latest CI runners have 4 vCPU, shared by the
     browser, Worker, and database; the chromium lane runs 2 Playwright
     workers (CUBBY_E2E_WORKERS), webkit stays at 1. Preserve the local
     fast-failure budget while giving CI scenarios more wall-clock room. */
  timeout: isCI ? 120_000 : 30_000,

  /* Global setup prepares the immutable Worker config and database template. */
  globalSetup: "./tests/e2e/e2e-global-setup.ts",

  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Browser canaries are deterministic contracts; retries hide flakes. */
  retries: 0,
  /* Each local worker owns an isolated database and harness. CI sets
     CUBBY_E2E_WORKERS per lane (2 for chromium, 1 for webkit); local macOS
     may override the measured cap. See tooling/e2e-workers.ts. */
  workers: resolveE2EWorkers(),
  /* Backstop for a dead worker harness, which fails every remaining test
     identically. Kept loose enough that a genuine multi-test regression still
     reports most of its failures in one go. */
  maxFailures: isCI ? 6 : 0,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: isCI
    ? [["github"], ["html"], ["./tests/e2e/e2e-harness-reporter.ts"]]
    : // `line` so a failing pre-push or verify run says which test failed in the
      // terminal; the HTML report alone leaves the hook's output blank.
      [["line"], ["html"], ["./tests/e2e/e2e-harness-reporter.ts"]],
  expect: {
    // Allow a bit more time on CI for client-side navigations
    timeout: isCI ? 15000 : 5000,
  },
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: "http://localhost:3001",

    /* retries: 0 means "on-first-retry" never fires — there is no retry to
       collect a trace on. Record on the first (only) failure instead. */
    trace: "retain-on-failure",
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "Unauthenticated tests",
      testMatch: /unauth\..*\.spec\.ts/,
      metadata: { authenticated: false },
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "Authenticated tests",
      testMatch: /\.spec\.ts$/,
      testIgnore: /(?:unauth|mobile)\./,
      metadata: { authenticated: true },
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "iPhone WebKit smoke",
      testMatch: /mobile\..*\.spec\.ts/,
      metadata: { authenticated: true },
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 402, height: 874 },
        contextOptions: { screen: { width: 402, height: 874 } },
        deviceScaleFactor: 3,
      },
    },
  ],

  /* Each Playwright worker owns its database, object storage, and harness. */
});
