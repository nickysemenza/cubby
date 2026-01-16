import { expect, test } from "@playwright/test";
import {
  addInventory,
  createLocation,
  createProduct,
  waitForFormHydration,
} from "./bulk-move-helpers";

test.describe("Bulk Move Inventory - Selection", () => {
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
    await expect(locationSearch).toBeVisible({ timeout: 5000 });
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
    await expect(sourceSearch).toBeVisible({ timeout: 5000 });
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
