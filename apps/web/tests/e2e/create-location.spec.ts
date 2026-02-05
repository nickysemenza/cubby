import { expect, test } from "@playwright/test";
import { waitForFormHydration } from "./e2e-helpers";

test.describe("Create Location", () => {
  test("can create a new location and view detail", async ({ page }) => {
    const name = `E2E Location ${Date.now()}`;

    await page.goto("/locations/new");
    await waitForFormHydration(page);

    // Fill in the form
    const nameInput = page.getByPlaceholder("Enter location name");
    await expect(nameInput).toBeVisible();
    await nameInput.click();
    await nameInput.clear();
    await nameInput.pressSequentially(name, { delay: 10 });
    await nameInput.blur();

    await expect(nameInput).toHaveValue(name);

    // Submit
    await page.getByRole("button", { name: /^Create$/ }).click();

    // Expect redirect to detail page for the new location
    await expect(page).toHaveURL(/\/locations\/[a-f0-9-]+/, { timeout: 15000 });

    // Wait for page to stabilize and check for the location name
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 10000 });
  });
});
