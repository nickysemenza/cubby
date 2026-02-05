import { expect, type Page } from "@playwright/test";

// Helper to wait for form hydration (React needs time to hydrate after SSR)
export async function waitForFormHydration(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  // Wait for the form's submit button to appear (indicates React has hydrated the form)
  await expect(page.getByRole("button", { name: /Create|Save/ })).toBeVisible({
    timeout: 15000,
  });
}

// Helper to create a location via UI
export async function createLocation(page: Page, name: string) {
  await page.goto("/locations/new");
  await page.waitForLoadState("domcontentloaded");
  await page.getByPlaceholder("Enter location name").fill(name);
  await page.getByRole("button", { name: /^Create$/ }).click();
  await expect(page).toHaveURL(/\/locations\//);
}

// Helper to create a product via UI
export async function createProduct(page: Page, name: string) {
  await page.goto("/products/new");
  await page.waitForLoadState("domcontentloaded");
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

  // Select product using combobox (aria-label is lowercase)
  const productCombobox = page.getByRole("combobox", { name: /product/i });
  await expect(productCombobox).toBeVisible({ timeout: 10000 });
  await productCombobox.click();

  // Search for the product
  const productSearch = page.getByPlaceholder("Search product...");
  await expect(productSearch).toBeVisible({ timeout: 5000 });
  await productSearch.fill(productName);

  // Wait for and click the option (button includes manufacturer suffix like "(unspecified)")
  await expect(page.getByRole("button", { name: productName })).toBeVisible({
    timeout: 10000,
  });
  await page.getByRole("button", { name: productName }).click();

  // Select location using combobox (aria-label is lowercase)
  const locationCombobox = page.getByRole("combobox", { name: /location/i });
  await expect(locationCombobox).toBeVisible({ timeout: 10000 });
  await locationCombobox.click();

  // Search for the location
  const locationSearch = page.getByPlaceholder("Search location...");
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
