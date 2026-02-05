import { expect, test } from "@playwright/test";

test.describe("Create Product", () => {
  test("can create a new product and view detail", async ({ page }) => {
    const name = `E2E Product ${Date.now()}`;

    // Navigate directly to New Product page
    await page.goto("/products/new");
    await expect(page).toHaveURL(/\/products\/new/);

    // Wait for hydration: the React app takes over the server-rendered HTML
    await page.waitForLoadState("networkidle");

    // Wait for the form's submit button to appear (indicates React has hydrated)
    await expect(page.getByRole("button", { name: /^Create$/ })).toBeVisible({
      timeout: 10000,
    });

    // Additional delay to ensure form is fully interactive
    await page.waitForTimeout(500);

    // Fill in the form - use click and pressSequentially for proper React event handling
    const nameInput = page.getByPlaceholder("Enter product name");
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toBeEnabled();

    await nameInput.click();
    await nameInput.clear();
    await nameInput.pressSequentially(name, { delay: 10 });
    await nameInput.blur();

    const manufacturerInput = page.getByPlaceholder("Enter manufacturer");
    await manufacturerInput.click();
    await manufacturerInput.clear();
    await manufacturerInput.pressSequentially("E2E Manufacturer", {
      delay: 10,
    });
    await manufacturerInput.blur();

    // Verify the values were entered
    await expect(nameInput).toHaveValue(name);

    // Submit
    await page.getByRole("button", { name: /^Create$/ }).click();

    // Expect redirect to detail page for the new product
    await expect(page).toHaveURL(/\/products\/[a-f0-9-]+/, { timeout: 15000 });
    await expect(
      page.getByRole("heading", { name: `Product: ${name}` }),
    ).toBeVisible({ timeout: 10000 });

    // Basic Information section should exist
    await expect(page.getByText("Basic Information")).toBeVisible();
  });
});
