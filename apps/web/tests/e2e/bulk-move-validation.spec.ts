import { expect, test } from "@playwright/test";
import {
  addInventory,
  createLocation,
  createProduct,
  waitForFormHydration,
} from "./bulk-move-helpers";

test.describe("Bulk Move Inventory - Validation", () => {
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

    // Select source location (aria-label is lowercase)
    const sourceCombobox = page.getByRole("combobox", {
      name: /from location/i,
    });
    await expect(sourceCombobox).toBeVisible({ timeout: 10000 });
    await sourceCombobox.click();

    const sourceSearch = page.getByPlaceholder("Search from location...");
    await expect(sourceSearch).toBeVisible({ timeout: 5000 });
    await sourceSearch.fill(locationName);
    await expect(page.getByRole("button", { name: locationName })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: locationName }).click();

    // Wait for items to load and select
    await expect(page.getByText(`Items at ${locationName}`)).toBeVisible();
    const checkbox = page.getByRole("checkbox").first();
    await checkbox.click();

    // Select same location as target (aria-label is lowercase)
    const targetCombobox = page.getByRole("combobox", {
      name: /to location/i,
    });
    await expect(targetCombobox).toBeVisible({ timeout: 10000 });
    await targetCombobox.click();

    const targetSearch = page.getByPlaceholder("Search to location...");
    await expect(targetSearch).toBeVisible({ timeout: 5000 });
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
});
