import {
  seedInventoryPrerequisites,
  seedLocationPrerequisite,
} from "./e2e-fixtures";
import { selectComboboxItem, waitForFormHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test.describe("Bulk Move Inventory - Transfer", () => {
  test("can move inventory items between locations", async ({ page }) => {
    const timestamp = Date.now();
    const sourceName = `E2E Move Source ${timestamp}`;
    const targetName = `E2E Move Target ${timestamp}`;
    const productName = `E2E Move Product ${timestamp}`;

    await Promise.all([
      seedInventoryPrerequisites(page, {
        locationName: sourceName,
        products: [{ name: productName, quantity: 10, unit: "units" }],
      }),
      seedLocationPrerequisite(page, targetName),
    ]);

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
