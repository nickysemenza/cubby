import { expect, test } from "@playwright/test";
import { waitForFormHydration } from "./e2e-helpers";

test.describe("Create Product", () => {
  test("can create a new product and view detail", async ({ page }) => {
    const name = `E2E Product ${Date.now()}`;

    await page.goto("/products/new");
    await waitForFormHydration(page);

    // Fill in the form
    const nameInput = page.getByPlaceholder("Enter product name");
    await expect(nameInput).toBeVisible();
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
