import { expect, test } from "@playwright/test";

test.describe("Main navigation", () => {
  test("mobile bottom nav links work", async ({ page }) => {
    await page.goto("/");
    await page.setViewportSize({ width: 375, height: 812 });

    // Bottom nav should be visible on mobile
    const bottomNav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(bottomNav).toBeVisible();

    // Inventory link should be directly visible in bottom nav
    const inventoryLink = bottomNav.getByRole("link", { name: "Inventory" });
    await expect(inventoryLink).toBeVisible({ timeout: 5000 });

    // Click the link — unauthenticated users get redirected to sign-in by the _authenticated layout
    await inventoryLink.click();
    await page.waitForURL(/\/auth\/sign-in/, { timeout: 15000 });
  });
});
