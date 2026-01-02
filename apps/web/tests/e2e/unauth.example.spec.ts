import { expect, test } from "@playwright/test";

test("has title", async ({ page }) => {
  await page.goto("/");

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/RecipeHub/);
});

test("get started link", async ({ page }) => {
  await page.goto("/");

  // Click a visible nav link in the navigation bar (not the homepage card)
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Products" })
    .click();
  await expect(page).toHaveURL(/\/products/);
});
