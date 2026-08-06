import { expect, test } from "@playwright/test";
import {
  addInventory,
  createLocation,
  createProduct,
  selectComboboxItem,
  waitForFormHydration,
} from "./e2e-helpers";

test.describe("Bulk Move Inventory - Validation", () => {
  test("shows error when source and target are the same", async ({ page }) => {
    const timestamp = Date.now();
    const locationName = `E2E Same Location ${timestamp}`;
    const productName = `E2E Same Product ${timestamp}`;

    await createLocation(page, locationName);
    await createProduct(page, productName);
    await addInventory(page, productName, locationName, 10, "units");

    await page.goto("/inventory/bulk-move");
    await waitForFormHydration(page);

    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /from location/i }),
      locationName,
    );

    await expect(page.getByText(`Items at ${locationName}`)).toBeVisible();
    const checkbox = page.getByRole("checkbox").first();
    await expect(checkbox).toBeVisible({ timeout: 10000 });
    await checkbox.click();

    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /to location/i }),
      locationName,
    );

    await page.getByRole("button", { name: /Move 1 Item/i }).click();

    await expect(
      page.getByText(/Source and target locations must be different/i),
    ).toBeVisible();
  });
});
