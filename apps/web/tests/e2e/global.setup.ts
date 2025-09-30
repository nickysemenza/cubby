import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

// Setup must be run serially, this is necessary if Playwright is configured to run fully parallel
setup.describe.configure({ mode: "serial" });

// Configure Playwright with Clerk
setup("global setup", async ({}) => {
  await clerkSetup();
});

// Define the path to the storage file, which is `user.json`
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.join(__dirname, "../../playwright/.clerk/user.json");

setup("authenticate and save state to storage", async ({ page }) => {
  // Perform authentication steps.
  // This example uses a Clerk helper to authenticate
  await page.goto("/");

  // Check if we have test credentials in environment
  const testUsername = process.env.E2E_CLERK_USER_USERNAME;
  const testPassword = process.env.E2E_CLERK_USER_PASSWORD;

  if (!testUsername || !testPassword) {
    console.warn(
      "No test credentials found. Set E2E_CLERK_USER_USERNAME and E2E_CLERK_USER_PASSWORD environment variables.",
    );
    return;
  }

  await clerk.signIn({
    page,
    signInParams: {
      strategy: "password",
      identifier: testUsername,
      password: testPassword,
    },
  });

  // Navigate to a protected page to verify authentication
  await page.goto("/products");

  // Wait for the page to load and ensure we're authenticated
  // Look for something that indicates we're logged in
  await page.waitForLoadState("networkidle");

  // Save the authentication state
  await page.context().storageState({ path: authFile });
});
