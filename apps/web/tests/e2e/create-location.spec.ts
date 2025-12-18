import { expect, test } from "@playwright/test";

test.describe("Create Location", () => {
  test("can create a new location and view detail", async ({ page }) => {
    const name = `E2E Location ${Date.now()}`;

    // Go to Locations and then to New Location page
    await page.goto("/locations");
    await page.getByRole("button", { name: /New Location/i }).click();

    await expect(page).toHaveURL(/\/locations\/new/);

    // Fill in the form
    await page.getByPlaceholder("Enter location name").fill(name);
    // Type defaults to "room"; leave it as-is

    // Submit
    await page.getByRole("button", { name: /^Create$/ }).click();

    // Expect redirect to detail page for the new location
    await expect(page).toHaveURL(/\/locations\//);
    // The location breadcrumb uses a custom nav element with aria-label
    const breadcrumbNav = page.locator('nav[aria-label="Location breadcrumb"]');
    await expect(breadcrumbNav.getByText(name)).toBeVisible();
    // Some canonical sections on the detail page
    await expect(
      page.getByText("Child Locations", { exact: true }),
    ).toBeVisible();
  });
});
