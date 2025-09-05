import { expect, test } from "@playwright/test";

test.describe("Create Product", () => {
  test("can create a new product and view detail", async ({ page }) => {
    const name = `E2E Product ${Date.now()}`;

    // Go to Products and then to New Product page
    await page.goto("/products");
    await page.getByRole("button", { name: /Create New Product/i }).click();

    await expect(page).toHaveURL(/\/products\/new/);

    // Fill in the form
    await page.getByPlaceholder("Enter product name").fill(name);
    await page.getByPlaceholder("Enter manufacturer").fill("E2E Manufacturer");

    // Submit
    await page.getByRole("button", { name: /^Create$/ }).click();

    // Expect redirect to detail page for the new product
    await expect(page).toHaveURL(/\/products\//);
    await expect(
      page.getByRole("heading", { name: `🛒Product Detail: ${name}` }),
    ).toBeVisible();

    // Basic Information section should exist
    await expect(page.getByText("Basic Information")).toBeVisible();
  });
});
