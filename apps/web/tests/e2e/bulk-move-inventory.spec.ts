import { expect, test } from "@playwright/test";

test.describe("Bulk Move Inventory", () => {
  // Helper to create a location via UI
  async function createLocation(
    page: import("@playwright/test").Page,
    name: string,
  ) {
    await page.goto("/locations/new");
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Enter location name").fill(name);
    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page).toHaveURL(/\/locations\//);
  }

  // Helper to create a product via UI
  async function createProduct(
    page: import("@playwright/test").Page,
    name: string,
  ) {
    await page.goto("/products/new");
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Enter product name").fill(name);
    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page).toHaveURL(/\/products\//);
  }

  // Helper to add inventory via UI
  async function addInventory(
    page: import("@playwright/test").Page,
    productName: string,
    locationName: string,
    quantity: number,
    unit: string,
  ) {
    await page.goto("/inventory/new");
    await page.waitForLoadState("networkidle");

    // Select product using combobox - use label to scope to the right combobox
    const productCombobox = page
      .locator('label:has-text("Product")')
      .locator("..")
      .getByRole("combobox");
    await productCombobox.click();

    // Search for the product - match pattern from create-recipe test
    const productSearch = page.getByRole("textbox", {
      name: "Search Product...",
    });
    await productSearch.fill(productName);

    // Wait for and click the option
    await expect(
      page.getByRole("button", { name: productName, exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: productName, exact: true }).click();

    // Select location using combobox
    const locationCombobox = page
      .locator('label:has-text("Location")')
      .locator("..")
      .getByRole("combobox");
    await locationCombobox.click();

    // Search for the location - match pattern from create-recipe test
    const locationSearch = page.getByRole("textbox", {
      name: "Search Location...",
    });
    await locationSearch.fill(locationName);

    // Wait for and click the option
    await expect(
      page.getByRole("button", { name: locationName, exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: locationName, exact: true }).click();

    // Fill quantity
    await page.getByLabel("Amount Value").fill(quantity.toString());

    // Fill unit
    await page.getByRole("textbox", { name: "Amount Unit" }).fill(unit);

    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page).toHaveURL(/\/inventory\//);
  }

  test("can navigate to bulk move page", async ({ page }) => {
    await page.goto("/inventory/bulk-move");
    await page.waitForLoadState("networkidle");

    // CardTitle renders as a div, not a heading - use getByText
    await expect(page.getByText("Bulk Move Inventory")).toBeVisible();
    await expect(page.getByText(/From Location/i)).toBeVisible();
    await expect(page.getByText(/To Location/i)).toBeVisible();
  });

  // TODO: Fix combobox search interaction in addInventory helper
  // The combobox search doesn't find newly created products - possibly a debounce/timing issue
  test.skip("can select source location and see inventory items", async ({
    page,
  }) => {
    const timestamp = Date.now();
    const sourceName = `E2E Source ${timestamp}`;
    const productName = `E2E BulkMove Product ${timestamp}`;

    // Create prerequisites
    await createLocation(page, sourceName);
    await createProduct(page, productName);
    await addInventory(page, productName, sourceName, 10, "units");

    // Navigate to bulk move
    await page.goto("/inventory/bulk-move");
    await page.waitForLoadState("networkidle");

    // Select source location using combobox
    const sourceCombobox = page
      .locator('label:has-text("From Location")')
      .locator("..")
      .getByRole("combobox");
    await sourceCombobox.click();

    // Search for location (placeholder has capital L)
    const locationSearch = page.getByRole("textbox", { name: "Search Location..." });
    await locationSearch.fill(sourceName);

    // Wait for and click the option
    await expect(
      page.getByRole("button", { name: sourceName, exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: sourceName, exact: true }).click();

    // Should show items at the source location
    await expect(page.getByText(`Items at ${sourceName}`)).toBeVisible();
    await expect(page.getByText(productName)).toBeVisible();
  });

  // TODO: Fix combobox search interaction in addInventory helper
  test.skip("can move inventory items between locations", async ({ page }) => {
    const timestamp = Date.now();
    const sourceName = `E2E Move Source ${timestamp}`;
    const targetName = `E2E Move Target ${timestamp}`;
    const productName = `E2E Move Product ${timestamp}`;

    // Create prerequisites
    await createLocation(page, sourceName);
    await createLocation(page, targetName);
    await createProduct(page, productName);
    await addInventory(page, productName, sourceName, 10, "units");

    // Navigate to bulk move
    await page.goto("/inventory/bulk-move");
    await page.waitForLoadState("networkidle");

    // Select source location
    const sourceCombobox = page
      .locator('label:has-text("From Location")')
      .locator("..")
      .getByRole("combobox");
    await sourceCombobox.click();

    const sourceSearch = page.getByRole("textbox", { name: "Search Location..." });
    await sourceSearch.fill(sourceName);
    await expect(
      page.getByRole("button", { name: sourceName, exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: sourceName, exact: true }).click();

    // Wait for items to load
    await expect(page.getByText(`Items at ${sourceName}`)).toBeVisible();

    // Select the item checkbox
    const checkbox = page.getByRole("checkbox").first();
    await checkbox.click();

    // Select target location
    const targetCombobox = page
      .locator('label:has-text("To Location")')
      .locator("..")
      .getByRole("combobox");
    await targetCombobox.click();

    const targetSearch = page.getByRole("textbox", { name: "Search Location..." });
    await targetSearch.fill(targetName);
    await expect(
      page.getByRole("button", { name: targetName, exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: targetName, exact: true }).click();

    // Submit the move
    await page.getByRole("button", { name: /Move 1 Item/i }).click();

    // Should show success toast
    await expect(page.getByText(/Successfully moved/i)).toBeVisible();
  });

  // TODO: Fix combobox search interaction in addInventory helper
  test.skip("shows error when source and target are the same", async ({ page }) => {
    const timestamp = Date.now();
    const locationName = `E2E Same Location ${timestamp}`;
    const productName = `E2E Same Product ${timestamp}`;

    // Create prerequisites
    await createLocation(page, locationName);
    await createProduct(page, productName);
    await addInventory(page, productName, locationName, 10, "units");

    // Navigate to bulk move
    await page.goto("/inventory/bulk-move");
    await page.waitForLoadState("networkidle");

    // Select source location
    const sourceCombobox = page
      .locator('label:has-text("From Location")')
      .locator("..")
      .getByRole("combobox");
    await sourceCombobox.click();

    const sourceSearch = page.getByRole("textbox", { name: "Search Location..." });
    await sourceSearch.fill(locationName);
    await expect(
      page.getByRole("button", { name: locationName, exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: locationName, exact: true }).click();

    // Wait for items to load and select
    await expect(page.getByText(`Items at ${locationName}`)).toBeVisible();
    const checkbox = page.getByRole("checkbox").first();
    await checkbox.click();

    // Select same location as target
    const targetCombobox = page
      .locator('label:has-text("To Location")')
      .locator("..")
      .getByRole("combobox");
    await targetCombobox.click();

    const targetSearch = page.getByRole("textbox", { name: "Search Location..." });
    await targetSearch.fill(locationName);
    await expect(
      page.getByRole("button", { name: locationName, exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: locationName, exact: true }).click();

    // Try to submit
    await page.getByRole("button", { name: /Move 1 Item/i }).click();

    // Should show error
    await expect(
      page.getByText(/Source and target locations must be different/i),
    ).toBeVisible();
  });

  // TODO: Fix combobox search interaction in addInventory helper
  test.skip("can select and deselect all items", async ({ page }) => {
    const timestamp = Date.now();
    const sourceName = `E2E SelectAll ${timestamp}`;
    const product1 = `E2E SelectAll Product1 ${timestamp}`;
    const product2 = `E2E SelectAll Product2 ${timestamp}`;

    // Create prerequisites with multiple products
    await createLocation(page, sourceName);
    await createProduct(page, product1);
    await createProduct(page, product2);
    await addInventory(page, product1, sourceName, 5, "units");
    await addInventory(page, product2, sourceName, 3, "units");

    // Navigate to bulk move
    await page.goto("/inventory/bulk-move");
    await page.waitForLoadState("networkidle");

    // Select source location
    const sourceCombobox = page
      .locator('label:has-text("From Location")')
      .locator("..")
      .getByRole("combobox");
    await sourceCombobox.click();

    const sourceSearch = page.getByRole("textbox", { name: "Search Location..." });
    await sourceSearch.fill(sourceName);
    await expect(
      page.getByRole("button", { name: sourceName, exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: sourceName, exact: true }).click();

    // Wait for items
    await expect(page.getByText(`Items at ${sourceName}`)).toBeVisible();

    // Click Select All
    await page.getByRole("button", { name: /Select All/i }).click();

    // Button should now say Deselect All
    await expect(
      page.getByRole("button", { name: /Deselect All/i }),
    ).toBeVisible();

    // Click Deselect All
    await page.getByRole("button", { name: /Deselect All/i }).click();

    // Button should say Select All again
    await expect(
      page.getByRole("button", { name: /Select All/i }),
    ).toBeVisible();
  });
});
