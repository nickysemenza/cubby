import { expect, test } from "@playwright/test";

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

  test("images page redirects to sign-in", async ({ page }) => {
    await page.goto("/images");
    await expect(page).toHaveURL(/\/auth\/sign-in/);
  });
});
