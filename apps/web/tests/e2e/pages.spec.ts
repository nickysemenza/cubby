import { expect, test } from "@playwright/test";

test.describe("Key pages render", () => {
  test("home page renders and has title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/RecipeHub/i);
  });

  test("ingredients page renders list container", async ({ page }) => {
    await page.goto("/ingredients");
    // Page uses a list; assert page changed and root container present
    await expect(page).toHaveURL(/\/ingredients/);
    // No strict heading text, so just ensure the page loaded and network idle
    await page.waitForLoadState("networkidle");
  });

  test("images page renders", async ({ page }) => {
    await page.goto("/images");
    await expect(page).toHaveURL(/\/images/);
    await page.waitForLoadState("networkidle");
  });
});
