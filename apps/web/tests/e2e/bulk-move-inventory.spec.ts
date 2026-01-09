import { expect, test } from "@playwright/test";

test.describe("Bulk Move Inventory", () => {
  // Helper to wait for form hydration (React Hook Form needs time to initialize)
  async function waitForFormHydration(page: import("@playwright/test").Page) {
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("button", { name: "React Hook Form Logo" }),
    ).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(500);
  }

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
    await waitForFormHydration(page);

    // Select product using combobox - use label to scope to the right combobox
    const productCombobox = page
      .locator('label:has-text("Product")')
      .locator("..")
      .getByRole("combobox");
    await productCombobox.click();

    // Search for the product - label is lowercased in combobox-dialog.tsx
    const productSearch = page.getByRole("textbox", {
      name: "Search product...",
    });
    await productSearch.fill(productName);

    // Wait for and click the option (button includes manufacturer suffix like "(unspecified)")
    await expect(page.getByRole("button", { name: productName })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: productName }).click();

    // Select location using combobox
    const locationCombobox = page
      .locator('label:has-text("Location")')
      .locator("..")
      .getByRole("combobox");
    await locationCombobox.click();

    // Search for the location - label is lowercased in combobox-dialog.tsx
    const locationSearch = page.getByRole("textbox", {
      name: "Search location...",
    });
    await locationSearch.fill(locationName);

    // Wait for and click the option
    await expect(page.getByRole("button", { name: locationName })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: locationName }).click();

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

  test("can select source location and see inventory items", async ({
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
    await waitForFormHydration(page);

    // Select source location using combobox
    const sourceCombobox = page
      .locator('label:has-text("From Location")')
      .locator("..")
      .getByRole("combobox");
    await sourceCombobox.click();

    // Search for location - "From Location" label becomes "Search from location..."
    const locationSearch = page.getByRole("textbox", {
      name: "Search from location...",
    });
    await locationSearch.fill(sourceName);

    // Wait for and click the option (includes room type suffix like "(room)")
    await expect(page.getByRole("button", { name: sourceName })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: sourceName }).click();

    // Should show items at the source location
    await expect(page.getByText(`Items at ${sourceName}`)).toBeVisible();
    await expect(page.getByText(productName)).toBeVisible();
  });

  test("can move inventory items between locations", async ({ page }) => {
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
    await waitForFormHydration(page);

    // Select source location
    const sourceCombobox = page
      .locator('label:has-text("From Location")')
      .locator("..")
      .getByRole("combobox");
    await sourceCombobox.click();

    const sourceSearch = page.getByRole("textbox", {
      name: "Search from location...",
    });
    await sourceSearch.fill(sourceName);
    await expect(page.getByRole("button", { name: sourceName })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: sourceName }).click();

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

    const targetSearch = page.getByRole("textbox", {
      name: "Search to location...",
    });
    await targetSearch.fill(targetName);
    await expect(page.getByRole("button", { name: targetName })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: targetName }).click();

    // Submit the move
    await page.getByRole("button", { name: /Move 1 Item/i }).click();

    // Should show success toast
    await expect(page.getByText(/Successfully moved/i)).toBeVisible();
  });

  test("shows error when source and target are the same", async ({ page }) => {
    const timestamp = Date.now();
    const locationName = `E2E Same Location ${timestamp}`;
    const productName = `E2E Same Product ${timestamp}`;

    // Create prerequisites
    await createLocation(page, locationName);
    await createProduct(page, productName);
    await addInventory(page, productName, locationName, 10, "units");

    // Navigate to bulk move
    await page.goto("/inventory/bulk-move");
    await waitForFormHydration(page);

    // Select source location
    const sourceCombobox = page
      .locator('label:has-text("From Location")')
      .locator("..")
      .getByRole("combobox");
    await sourceCombobox.click();

    const sourceSearch = page.getByRole("textbox", {
      name: "Search from location...",
    });
    await sourceSearch.fill(locationName);
    await expect(page.getByRole("button", { name: locationName })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: locationName }).click();

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

    const targetSearch = page.getByRole("textbox", {
      name: "Search to location...",
    });
    await targetSearch.fill(locationName);
    await expect(page.getByRole("button", { name: locationName })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: locationName }).click();

    // Try to submit
    await page.getByRole("button", { name: /Move 1 Item/i }).click();

    // Should show error
    await expect(
      page.getByText(/Source and target locations must be different/i),
    ).toBeVisible();
  });

  test("can select and deselect all items", async ({ page }) => {
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
    await waitForFormHydration(page);

    // Select source location
    const sourceCombobox = page
      .locator('label:has-text("From Location")')
      .locator("..")
      .getByRole("combobox");
    await sourceCombobox.click();

    const sourceSearch = page.getByRole("textbox", {
      name: "Search from location...",
    });
    await sourceSearch.fill(sourceName);
    await expect(page.getByRole("button", { name: sourceName })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: sourceName }).click();

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
