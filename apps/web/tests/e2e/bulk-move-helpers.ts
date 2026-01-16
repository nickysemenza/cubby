import { expect, type Page } from "@playwright/test";

// Helper to wait for form hydration (React Hook Form needs time to initialize)
export async function waitForFormHydration(page: Page) {
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("button", { name: "React Hook Form Logo" }),
  ).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(500);
}

// Helper to create a location via UI
export async function createLocation(page: Page, name: string) {
  await page.goto("/locations/new");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("Enter location name").fill(name);
  await page.getByRole("button", { name: /^Create$/ }).click();
  await expect(page).toHaveURL(/\/locations\//);
}

// Helper to create a product via UI
export async function createProduct(page: Page, name: string) {
  await page.goto("/products/new");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("Enter product name").fill(name);
  await page.getByRole("button", { name: /^Create$/ }).click();
  await expect(page).toHaveURL(/\/products\//);
}

// Helper to add inventory via UI
export async function addInventory(
  page: Page,
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
  await expect(productSearch).toBeVisible({ timeout: 5000 });
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
  await expect(locationSearch).toBeVisible({ timeout: 5000 });
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
