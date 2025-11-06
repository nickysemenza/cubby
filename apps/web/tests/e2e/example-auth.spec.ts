import { expect, test } from "@playwright/test";

test.describe("Auth: basic pages load", () => {
  test("sign-in page loads", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
