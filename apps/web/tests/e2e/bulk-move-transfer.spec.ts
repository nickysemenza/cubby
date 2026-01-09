import { expect, test } from "@playwright/test";
import {
  addInventory,
  createLocation,
  createProduct,
  waitForFormHydration,
} from "./bulk-move-helpers";

test.describe("Bulk Move Inventory - Transfer", () => {
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
});
