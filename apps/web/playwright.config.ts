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

export default defineConfig({
  testDir: "./tests/e2e",

  /* Global setup/teardown - starts dev server with fresh IntegresQL database */
  globalSetup: "./tests/e2e/e2e-global-setup.ts",
  globalTeardown: "./tests/e2e/e2e-global-teardown.ts",

  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: isCI
    ? [
        ["github"],
        [
          "junit",
          {
            outputFile: "test-results/junit.xml",
            embedAnnotationsAsProperties: true,
          },
        ],
        ["html"],
      ]
    : "html",
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
      testMatch: /(?!unauth\.).*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        // Use prepared better-auth state (saved by globalSetup)
        storageState: "playwright/.auth/user.json",
      },
    },
  ],

  /* Note: webServer is handled by globalSetup with IntegresQL fresh database */
});
