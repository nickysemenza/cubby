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

// The spec files import server modules (`~/server/db`, repositories) whose
// `~/env` schema validates at import and whose module scope reads values like
// `new URL(env.R2_PUBLIC_URL)`, so the Playwright process itself needs a
// complete server env even though every Worker gets its own from
// e2e-worker-runtime.ts. Locally `.env` above supplies it; CI has no `.env`,
// so fill in placeholders the way vitest.config.ts does. Values already in the
// environment win. DATABASE_URL matches the CI postgres service so the eager
// module pool in `~/server/db` points somewhere real; the fixtures themselves
// connect through E2E_DATABASE_URL.
const e2eProcessEnvDefaults = {
  DATABASE_URL: "postgresql://postgres:password@localhost:5432/cubby",
  R2_ACCESS_KEY_ID: "e2e",
  R2_SECRET_ACCESS_KEY: "e2e",
  R2_ENDPOINT: "http://localhost:9000",
  R2_BUCKET_NAME: "e2e",
  R2_PUBLIC_URL: "http://localhost:9000",
  UPC_LOOKUP_API_URL: "http://127.0.0.1:9/",
  BETTER_AUTH_SECRET: "e2e-test-secret",
};
for (const [key, value] of Object.entries(e2eProcessEnvDefaults)) {
  process.env[key] ??= value;
}

/** The iPhone 13 screen as current iOS reports it (402x874 at 3x). */
const iPhone13Metrics = {
  viewport: { width: 402, height: 874 },
  contextOptions: { screen: { width: 402, height: 874 } },
  deviceScaleFactor: 3,
};

/**
 * See https://playwright.dev/docs/test-configuration.
 */
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests/e2e",
  /* Public-repository ubuntu-latest CI runners have 4 vCPU, shared by the
     browser, Worker, and database. CI runs one Playwright worker per runner
     and shards chromium across two runners (--shard) instead of running
     multiple workers on one — two workers on a single runner flaked (see
     tooling/e2e-workers.ts). Preserve the local fast-failure budget while
     giving CI scenarios more wall-clock room. */
  timeout: isCI ? 120_000 : 30_000,

  /* Global setup prepares the immutable Worker config and database template. */
  globalSetup: "./tests/e2e/e2e-global-setup.ts",

  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Browser canaries are deterministic contracts; retries hide flakes. */
  retries: 0,
  /* Each local worker owns an isolated database and harness. CI runs one
     worker per runner (see the timeout comment above for why); local macOS
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
    screenshot: "only-on-failure",
  },

  /* Projects split by layout, not engine. Desktop users run Chrome, and
     Playwright's WebKit is not iOS Safari, so phone layout runs on Chromium
     at iPhone 13 metrics (`mobile.*`). WebKit keeps only engine-specific
     cases (`webkit.*`). Server/API contracts run once, in the desktop project.
     Patterns anchor on the basename so a mid-name match cannot move a spec
     between projects. */
  projects: [
    {
      name: "Unauthenticated tests",
      testMatch: /(^|\/)unauth\.[^/]*\.spec\.ts$/,
      metadata: { authenticated: false },
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "Authenticated tests",
      testMatch: /\.spec\.ts$/,
      testIgnore: /(^|\/)(?:unauth|mobile|webkit)\.[^/]*\.spec\.ts$/,
      metadata: { authenticated: true },
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "Chromium phone",
      testMatch: /(^|\/)mobile\.[^/]*\.spec\.ts$/,
      metadata: { authenticated: true },
      use: {
        ...devices["iPhone 13"],
        ...iPhone13Metrics,
        browserName: "chromium",
      },
    },
    {
      name: "WebKit smoke",
      testMatch: /(^|\/)webkit\.[^/]*\.spec\.ts$/,
      metadata: { authenticated: true },
      use: {
        ...devices["iPhone 13"],
        ...iPhone13Metrics,
      },
    },
  ],

  /* Each Playwright worker owns its database, object storage, and harness. */
});
