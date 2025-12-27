import { expect, test } from "@playwright/test";

test.describe("Create Location", () => {
  test("can create a new location and view detail", async ({ page }) => {
    const name = `E2E Location ${Date.now()}`;

    // Navigate directly to New Location page
    // Note: The "New Location" button is only visible in the gallery header when locations exist
    await page.goto("/locations/new");
    await expect(page).toHaveURL(/\/locations\/new/);

    // Fill in the form
    await page.getByPlaceholder("Enter location name").fill(name);
    // Type defaults to "room"; leave it as-is

    // Submit
    await page.getByRole("button", { name: /^Create$/ }).click();

    // Expect redirect to detail page for the new location
    // Use a longer timeout since server actions can be slow
    await expect(page).toHaveURL(/\/locations\/[a-f0-9-]+/, { timeout: 10000 });

    // Wait for page to stabilize and check for the location name somewhere on the page
    // The breadcrumb or heading should contain the name
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 10000 });
  });
});
