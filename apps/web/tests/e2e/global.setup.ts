import { faker } from "@faker-js/faker";
import { test as setup } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

// Setup must be run serially, this is necessary if Playwright is configured to run fully parallel
setup.describe.configure({ mode: "serial" });

// Define the path to the storage file, which is `user.json`
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.join(__dirname, "../../playwright/.auth/user.json");

setup("authenticate with better-auth and save state", async ({ page }) => {
  // Check if we have test credentials in environment
  const testEmail = process.env.E2E_TEST_USER_EMAIL;
  const testPassword = process.env.E2E_TEST_USER_PASSWORD;

  if (!testEmail || !testPassword) {
    console.warn(
      "No test credentials found. Set E2E_TEST_USER_EMAIL and E2E_TEST_USER_PASSWORD environment variables.",
    );
    return;
  }

  // Navigate to home page first
  await page.goto("/");

  // Sign up a new user (or sign in if already exists)
  // We'll use the auth API endpoints directly via fetch
  const baseURL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // Try to sign up first
  const signUpResponse = await page.request.post(
    `${baseURL}/api/auth/sign-up/email`,
    {
      headers: {
        Origin: baseURL,
      },
      data: {
        email: testEmail,
        password: testPassword,
        name: "E2E Test User",
      },
    },
  );

  // If sign up fails (user exists), try to sign in instead
  if (!signUpResponse.ok()) {
    console.log("User already exists, signing in instead...");
  }

  // Sign in to get session
  const signInResponse = await page.request.post(
    `${baseURL}/api/auth/sign-in/email`,
    {
      headers: {
        Origin: baseURL,
      },
      data: {
        email: testEmail,
        password: testPassword,
      },
    },
  );

  if (!signInResponse.ok()) {
    const errorText = await signInResponse.text();
    throw new Error(
      `Failed to sign in: ${signInResponse.status()} - ${errorText}`,
    );
  }

  // The sign-in response should set cookies automatically
  // Now we need to create an organization and set it as active

  // Navigate to the app to establish the session in the browser context
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // Create an organization using the better-auth API
  const createOrgResponse = await page.request.post(
    `${baseURL}/api/auth/organization/create`,
    {
      headers: {
        Origin: baseURL,
      },
      data: {
        name: `E2E Test Organization ${faker.company.name()} ${faker.airline.airline()}`,
        // faker.slug()
        slug: faker.lorem.slug(),
        // slug: "e2e-test-org",
      },
    },
  );

  if (!createOrgResponse.ok()) {
    const errorText = await createOrgResponse.text();
    throw new Error(
      `Failed to create organization: ${createOrgResponse.status()} - ${errorText}`,
    );
  }

  const orgData = await createOrgResponse.json();
  const organizationId = orgData.id;

  // Set the organization as active
  const setActiveOrgResponse = await page.request.post(
    `${baseURL}/api/auth/organization/set-active`,
    {
      headers: {
        Origin: baseURL,
      },
      data: {
        organizationId,
      },
    },
  );

  if (!setActiveOrgResponse.ok()) {
    const errorText = await setActiveOrgResponse.text();
    throw new Error(
      `Failed to set active organization: ${setActiveOrgResponse.status()} - ${errorText}`,
    );
  }

  // Navigate to home page first to refresh session with active organization context
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // Then navigate to a protected page to verify authentication
  await page.goto("/dashboard");

  // Wait for the page to load and ensure we're authenticated
  await page.waitForLoadState("networkidle");

  // Save the authentication state
  await page.context().storageState({ path: authFile });

  console.log("✓ E2E authentication setup complete");
  console.log(`  - User: ${testEmail}`);
  console.log(`  - Organization: E2E Test Organization`);
  console.log(`  - Auth state saved to: ${authFile}`);
});
