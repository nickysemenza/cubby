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

/**
 * See https://playwright.dev/docs/test-configuration.
 */
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests/e2e",
  /* Public-repository ubuntu-latest CI runners have 4 vCPU, shared by the
     browser, Worker, and database. CI shards desktop tests across two runners;
     its workflow currently benchmarks three workers per runner via --workers.
     Preserve the local fast-failure budget while giving CI scenarios more
     wall-clock room. */
  timeout: isCI ? 120_000 : 30_000,

  /* Global setup prepares the immutable Worker config and database template. */
  globalSetup: "./tests/e2e/e2e-global-setup.ts",

  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Browser canaries are deterministic contracts; retries hide flakes. */
  retries: 0,
  /* Each worker owns an isolated database and harness. The CI workflow can
     override this default through --workers; local macOS may override its
     measured cap. See tooling/e2e-workers.ts. */
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
    // The app's reduced-motion stylesheet removes animation and transition
    // waits from UI acceptance flows; animation quality is not this gate's
    // contract.
    reducedMotion: "reduce",

    /* retries: 0 means "on-first-retry" never fires — there is no retry to
       collect a trace on. Record on the first (only) failure instead. */
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  /* Authentication modes share one desktop browser. Patterns anchor on the
     basename so a mid-name match cannot move a spec between projects. */
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
      testIgnore: /(^|\/)unauth\.[^/]*\.spec\.ts$/,
      metadata: { authenticated: true },
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],

  /* Each Playwright worker owns its database, object storage, and harness. */
});
