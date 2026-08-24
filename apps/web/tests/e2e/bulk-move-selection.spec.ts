import { seedInventoryPrerequisites } from "./e2e-fixtures";
import { selectComboboxItem, waitForFormHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test.describe("Bulk Move Inventory - Selection", () => {
  test.describe.configure({ mode: "serial" });

  test("can select and deselect all items", async ({ page }) => {
    const timestamp = Date.now();
    const sourceName = `E2E SelectAll ${timestamp}`;
    const product1 = `E2E SelectAll Product1 ${timestamp}`;
    const product2 = `E2E SelectAll Product2 ${timestamp}`;

    await seedInventoryPrerequisites(page, {
      locationName: sourceName,
      products: [
        { name: product1, quantity: 5, unit: "units" },
        { name: product2, quantity: 3, unit: "units" },
      ],
    });

    await page.goto("/inventory/bulk-move");
    await waitForFormHydration(page);

    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /from location/i }),
      sourceName,
    );

    await expect(page.getByText(`Items at ${sourceName}`)).toBeVisible();
    const selectAllButton = page.getByRole("button", { name: /Select All/i });
    await expect(selectAllButton).toBeVisible({ timeout: 10000 });

    await selectAllButton.click();

    await expect(
      page.getByRole("button", { name: /Deselect All/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: /Deselect All/i }).click();

    await expect(
      page.getByRole("button", { name: /Select All/i }),
    ).toBeVisible();
  });
});
