import { expect, test } from "@playwright/test";

test.describe("Main navigation", () => {
  test("mobile bottom nav links work", async ({ page }) => {
    // Mobile viewport first so the page renders the (md:hidden) bottom nav from
    // the start, then wait for hydration so the <Link> does a client-side nav.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Bottom nav should be visible on mobile
    const bottomNav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(bottomNav).toBeVisible();

    // Inventory link should be directly visible in bottom nav
    const inventoryLink = bottomNav.getByRole("link", { name: "Inventory" });
    await expect(inventoryLink).toBeVisible({ timeout: 5000 });

    // Click the link — unauthenticated users are redirected to sign-in by the
    // _authenticated beforeLoad, which awaits authClient.getSession(). That
    // session check can be slow under parallel test load, so allow generous time.
    await inventoryLink.click();
    await page.waitForURL(/\/auth\/sign-in/, { timeout: 30000 });
  });
});
