import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

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
const localUsesPGlite =
  !isCI && (process.env.CUBBY_E2E_DATABASE ?? "pglite") === "pglite";

export default defineConfig({
  testDir: "./tests/e2e",
  /* Private-repository CI runners have two CPUs; browser, Worker, and database
     share them. Preserve the local fast-failure budget while giving the same
     CI scenarios the wall-clock room they had on public four-CPU runners. */
  timeout: isCI ? 120_000 : 30_000,

  /* Global setup/teardown starts the Worker harness with a fresh database. */
  globalSetup: "./tests/e2e/e2e-global-setup.ts",
  globalTeardown: "./tests/e2e/e2e-global-teardown.ts",

  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Local PGlite runs share one WASM database and socket server. Keep that
     resource-constrained lane single-worker for predictable fixture lifetime
     and memory use; the socket package's protocol-affinity patch itself keeps
     concurrent query cycles correlated. Preserve CI/PostgreSQL parallelism. */
  workers: localUsesPGlite ? 1 : isCI ? 2 : undefined,
  /* Backstop for a dead dev server, which fails every remaining test
     identically (see the exit handler in e2e-global-setup.ts): uncapped, that
     is ~20 tests x 3 attempts of ECONNREFUSED burying the one line that
     explains the run. Kept loose enough that a genuine multi-test regression
     still reports most of its failures in one go. */
  maxFailures: isCI ? 6 : 0,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: isCI
    ? [["github"], ["html"], ["./tests/e2e/e2e-harness-reporter.ts"]]
    : [["html"], ["./tests/e2e/e2e-harness-reporter.ts"]],
  expect: {
    // Allow a bit more time on CI for client-side navigations
    timeout: isCI ? 15000 : 5000,
  },
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: "http://localhost:3001",

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "Unauthenticated tests",
      testMatch: /unauth\..*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "Authenticated tests",
      testMatch: /\.spec\.ts$/,
      testIgnore: /(?:unauth|mobile)\./,
      use: {
        ...devices["Desktop Chrome"],
        // Use prepared better-auth state (saved by globalSetup)
        storageState: "playwright/.auth/user.json",
      },
    },
    {
      name: "iPhone WebKit smoke",
      testMatch: /mobile\..*\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
        storageState: "playwright/.auth/user-webkit.json",
      },
    },
  ],

  /* The Cloudflare harness and selected database are handled by globalSetup. */
});
