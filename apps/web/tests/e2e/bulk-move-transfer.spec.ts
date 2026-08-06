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

    await createLocation(page, sourceName);
    await createLocation(page, targetName);
    await createProduct(page, productName);
    await addInventory(page, productName, sourceName, 10, "units");

    await page.goto("/inventory/bulk-move");
    await waitForFormHydration(page);

    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /from location/i }),
      sourceName,
    );

    await expect(page.getByText(`Items at ${sourceName}`)).toBeVisible();

    const checkbox = page.getByRole("checkbox").first();
    await expect(checkbox).toBeVisible({ timeout: 10000 });
    await checkbox.click();

    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /to location/i }),
      targetName,
    );

    await page.getByRole("button", { name: /Move 1 Item/i }).click();

    await expect(page.getByText(/Successfully moved/i)).toBeVisible();
  });
});
