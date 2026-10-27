import { defineConfig, devices } from "@playwright/test";

import type { WorkerdProfile } from "./tooling/workerd-harness";
import { prepareE2EProcessEnvironment } from "./tooling/e2e-process-env";

prepareE2EProcessEnvironment();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
const isCI = !!process.env.CI;

export default defineConfig<object, { workerdProfile: WorkerdProfile }>({
  testDir: "./tests/e2e",
  /* Public-repository ubuntu-latest CI runners have 4 vCPU, shared by the
     browser, Worker, and database. CI shards desktop tests across four runners;
     its workflow currently benchmarks two workers per runner via --workers.
     Preserve the local fast-failure budget while giving CI scenarios more
     wall-clock room. */
  timeout: isCI || process.env.CUBBY_E2E_VIDEO === "1" ? 120_000 : 30_000,

  /* Global setup prepares the immutable Worker config and database template. */
  globalSetup: "./tests/e2e/support/e2e-global-setup.ts",

  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* One CI retry turns a flake into a seconds-long "flaky" report instead of a
     whole-job rerun. A test reported flaky twice is quarantined with
     `test.fixme` and a GitHub issue; local runs keep failing fast. */
  retries: isCI ? 1 : 0,
  /* Each worker owns an isolated database and harness. Three local macOS
     workers made iPhone WebKit flake across four unrelated specs under host
     contention, so macOS defaults to two and other hosts to one. Use
     Playwright's --workers override, including CI's explicit two. */
  workers: !isCI && process.platform === "darwin" ? 2 : 1,
  // Independent scenarios keep reporting after failures; shard timeouts bound dead harnesses.
  maxFailures: 0,
  /* Name the slowest spec files after the run; per-test page-load time is
     the `e2e-navigation-ms` annotation in the HTML report. */
  reportSlowTests: { max: 10, threshold: 60_000 },
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  /* CI shards also write a blob; the CI report job merges them into one HTML
     report and the combined job summary. */
  reporter: isCI
    ? [
        ["github"],
        ["html"],
        ["blob"],
        ["./tests/e2e/support/e2e-harness-reporter.ts"],
      ]
    : // `line` so a failing pre-push or verify run says which test failed in the
      // terminal; the HTML report alone leaves the hook's output blank.
      [["line"], ["html"], ["./tests/e2e/support/e2e-harness-reporter.ts"]],
  expect: {
    // HD capture adds CPU work; opt-in review runs use the CI timing budget.
    timeout: isCI || process.env.CUBBY_E2E_VIDEO === "1" ? 15000 : 5000,
  },
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: "http://localhost:3001",
    // The app's reduced-motion stylesheet removes animation and transition
    // waits from UI acceptance flows; animation quality is not this gate's
    // contract.
    reducedMotion: "reduce",

    /* CI records only the retry of a failed test, so passing tests pay no
       tracing cost; locally nothing retries, so record and keep failures. */
    trace: {
      mode: isCI ? "on-first-retry" : "retain-on-failure",
      // Trace screenshots otherwise claim an 800×450 screencast before HD capture.
      screenshots: process.env.CUBBY_E2E_VIDEO !== "1",
    },
    screenshot: "only-on-failure",
  },

  /* Projects share one desktop browser. Patterns anchor on the basename so a
     mid-name match cannot move a spec between projects. */
  projects: [
    /* `gmail.*` specs run on the Gmail harness profile. One worker runs them
       all, and listing the project first puts them at the start of a shard,
       so that shard boots the Gmail harness once instead of once per worker,
       each later switching back to the default profile. */
    {
      name: "Gmail profile tests",
      testMatch: /(^|\/)gmail\.[^/]*\.spec\.ts$/,
      workers: 1,
      use: {
        ...devices["Desktop Chrome"],
        workerdProfile: "gmail",
      },
    },
    /* Signed-out specs set `test.use({ signedIn: false })`, a test-scoped
       option, so they share this project's workers. */
    {
      name: "Authenticated tests",
      testMatch: /\.spec\.ts$/,
      testIgnore:
        /(^|\/)(gmail\.[^/]*|purchase-import-run|household-exploration)\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    /* Opt-in screenshot/exploration lane; never splits regression workers. */
    {
      name: "Household exploration",
      testMatch: /(^|\/)household-exploration\.spec\.ts$/,
      workers: 1,
      use: { ...devices["Desktop Chrome"] },
    },
    /* The purchase agent with a scripted model: an informative CI lane
       (`test:e2e:ci:purchase-import`), outside the required desktop shards. */
    {
      name: "Purchase import agent",
      testMatch: /(^|\/)purchase-import-run\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],

  /* Each Playwright worker owns its database, object storage, and harness. */
});
