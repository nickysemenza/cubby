import { expect, test } from "@playwright/test";
import {
  addInventory,
  createLocation,
  createProduct,
  selectComboboxItem,
  waitForFormHydration,
} from "./e2e-helpers";

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
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /from location/i }),
      "Search from location...",
      sourceName,
    );

    // Wait for items to load (checkbox only appears after items load)
    await expect(page.getByText(`Items at ${sourceName}`)).toBeVisible();

    // Select the item checkbox
    const checkbox = page.getByRole("checkbox").first();
    await expect(checkbox).toBeVisible({ timeout: 10000 });
    await checkbox.click();

    // Select target location
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /to location/i }),
      "Search to location...",
      targetName,
    );

    // Submit the move
    await page.getByRole("button", { name: /Move 1 Item/i }).click();

    // Should show success toast
    await expect(page.getByText(/Successfully moved/i)).toBeVisible();
  });
});
