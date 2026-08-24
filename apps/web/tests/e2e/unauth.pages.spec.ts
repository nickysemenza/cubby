import { expect, test } from "./e2e-test";

test.describe("Unauthenticated access", () => {
  test("home page renders and has title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Cubby/i);
  });

  // Protected routes (under _authenticated) redirect unauthenticated users to
  // sign-in. The guard runs server-side (see ~/lib/auth-guard), so the redirect
  // happens on a direct/refresh load, not just client-side navigation.
  test("ingredients page redirects to sign-in", async ({ page }) => {
    await page.goto("/ingredients");
    await expect(page).toHaveURL(/\/auth\/sign-in/);
  });

  test("product detail redirects to sign-in before rendering", async ({
    page,
  }) => {
    await page.goto("/products/PRD-2222");
    await expect(page).toHaveURL(/\/auth\/sign-in/);
  });
});
