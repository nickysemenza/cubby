import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";

test.describe("Example: Individual test authentication", () => {
  test("can access protected page with individual test auth", async ({
    page,
  }) => {
    // Set up Clerk testing token for this specific test
    await setupClerkTestingToken({ page });

    // Navigate to a protected page
    await page.goto("/products");

    // The page should load successfully since we have the testing token
    await expect(page).toHaveURL(/\/products/);
    await page.waitForLoadState("networkidle");

    // This test demonstrates the individual test authentication approach
    // as an alternative to using stored auth state
  });
});
