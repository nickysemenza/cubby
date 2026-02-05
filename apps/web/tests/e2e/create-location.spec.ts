import { expect, test } from "@playwright/test";

test.describe("Create Location", () => {
  test("can create a new location and view detail", async ({ page }) => {
    const name = `E2E Location ${Date.now()}`;

    // Navigate directly to New Location page
    await page.goto("/locations/new");
    await expect(page).toHaveURL(/\/locations\/new/);

    // Wait for hydration: the React app takes over the server-rendered HTML
    await page.waitForLoadState("networkidle");

    // Wait for the form's submit button to appear (indicates React has hydrated)
    await expect(page.getByRole("button", { name: /^Create$/ })).toBeVisible({
      timeout: 10000,
    });

    // Additional delay to ensure form is fully interactive
    await page.waitForTimeout(500);

    // Wait for the form to be ready and interactable
    const nameInput = page.getByPlaceholder("Enter location name");
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toBeEnabled();

    // Click to focus, then clear and type (triggers proper React events)
    await nameInput.click();
    await nameInput.clear();
    await nameInput.pressSequentially(name, { delay: 10 });

    // Blur to ensure React Hook Form registers the change
    await nameInput.blur();

    // Verify the value was entered and the form registered the change
    await expect(nameInput).toHaveValue(name);

    // Submit
    await page.getByRole("button", { name: /^Create$/ }).click();

    // Expect redirect to detail page for the new location
    // Use a longer timeout since server actions can be slow
    await expect(page).toHaveURL(/\/locations\/[a-f0-9-]+/, { timeout: 15000 });

    // Wait for page to stabilize and check for the location name somewhere on the page
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 10000 });
  });
});
