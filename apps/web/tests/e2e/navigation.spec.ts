import { expect, test } from "@playwright/test";

test.describe("Main navigation", () => {
  test("shows links and navigates between pages", async ({ page }) => {
    await page.goto("/");

    // Desktop nav links should be visible
    const links = [
      { name: "Home", path: "/" },
      { name: "Recipes", path: "/recipes" },
      { name: "Ingredients", path: "/ingredients" },
      { name: "Products", path: "/products" },
      { name: "Locations", path: "/locations" },
      { name: "Inventory", path: "/inventory" },
      { name: "Images", path: "/images" },
    ];

    for (const link of links) {
      await expect(page.getByRole("link", { name: link.name })).toBeVisible();
    }

    // Navigate to a few key pages and verify headings/UI affordances
    await page.getByRole("link", { name: "Recipes" }).click();
    await expect(page).toHaveURL(/\/recipes/);
    await expect(
      page.getByRole("button", { name: "Create New Recipe (Compact)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create New Recipe", exact: true }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Locations" }).click();
    await expect(page).toHaveURL(/\/locations/);
    await expect(
      page.getByRole("heading", { name: /Locations/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /New Location/i }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Products" }).click();
    await expect(page).toHaveURL(/\/products/);
    await expect(
      page.getByRole("heading", { name: /Products/i }),
    ).toBeVisible();
  });

  test("mobile menu toggles and links work", async ({ page }) => {
    await page.goto("/");
    await page.setViewportSize({ width: 375, height: 812 });

    // Open mobile menu
    await page.getByRole("button", { name: /toggle menu/i }).click();

    // Click a link from the mobile menu
    await page.getByRole("link", { name: "Inventory" }).click();
    await expect(page).toHaveURL(/\/inventory/);
    await expect(
      page.getByRole("heading", { name: /Inventory Items/i }),
    ).toBeVisible();
  });
});
