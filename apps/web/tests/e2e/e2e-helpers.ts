import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Wait for React to hydrate a form after SSR.
 *
 * Uses `networkidle` (not `domcontentloaded`) so that all JS bundles have been
 * downloaded AND executed before we start interacting with the page.
 */
export async function waitForFormHydration(page: Page) {
  await page.waitForLoadState("networkidle");
  // Match any common submit-button text (Create, Save, Move …)
  await expect(
    page.getByRole("button", { name: /Create|Save|Move/ }),
  ).toBeVisible({ timeout: 15000 });
}

/**
 * Click a DialogCompatibleCombobox and select an item from the dropdown.
 *
 * Uses Playwright's `toPass` retry to handle the SSR-hydration race:
 * keeps clicking the combobox until `aria-expanded` becomes "true",
 * which means React's onClick handler has fired and set the open state.
 */
export async function selectComboboxItem(
  page: Page,
  combobox: Locator,
  searchPlaceholder: string,
  itemName: string,
) {
  await expect(combobox).toBeVisible({ timeout: 10000 });

  // Retry click until React's state update sets aria-expanded="true"
  await expect(async () => {
    await combobox.click();
    await expect(combobox).toHaveAttribute("aria-expanded", "true");
  }).toPass({ timeout: 5000 });

  const searchInput = page.getByPlaceholder(searchPlaceholder);
  await expect(searchInput).toBeVisible({ timeout: 5000 });
  await searchInput.fill(itemName);

  // Wait for and click the matching option
  const option = page.getByRole("button", { name: itemName });
  await expect(option).toBeVisible({ timeout: 10000 });
  await option.click();
}

// Helper to create a location via UI
export async function createLocation(page: Page, name: string) {
  await page.goto("/locations/new");
  await waitForFormHydration(page);
  await page.getByPlaceholder("Enter location name").fill(name);
  await page.getByRole("button", { name: /^Create$/ }).click();
  await expect(page).toHaveURL(/\/locations\//, { timeout: 15000 });
}

// Helper to create a product via UI
export async function createProduct(page: Page, name: string) {
  await page.goto("/products/new");
  await waitForFormHydration(page);
  await page.getByPlaceholder("Enter product name").fill(name);
  await page.getByRole("button", { name: /^Create$/ }).click();
  await expect(page).toHaveURL(/\/products\//, { timeout: 15000 });
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

  // Select product
  await selectComboboxItem(
    page,
    page.getByRole("combobox", { name: /product/i }),
    "Search product...",
    productName,
  );

  // Select location
  await selectComboboxItem(
    page,
    page.getByRole("combobox", { name: /location/i }),
    "Search location...",
    locationName,
  );

  // Fill quantity
  await page.getByLabel("Amount Value").fill(quantity.toString());

  // Fill unit
  await page.getByRole("textbox", { name: "Amount Unit" }).fill(unit);

  await page.getByRole("button", { name: /^Create$/ }).click();
  await expect(page).toHaveURL(/\/inventory\//, { timeout: 15000 });
}
