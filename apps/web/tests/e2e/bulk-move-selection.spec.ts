import { expect, test } from "@playwright/test";
import {
  addInventory,
  createLocation,
  createProduct,
  selectComboboxItem,
  waitForFormHydration,
} from "./e2e-helpers";

test.describe("Bulk Move Inventory - Selection", () => {
  test.describe.configure({ mode: "serial" });

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

    // Page renders its labels (folded in from the former bulk-move-navigation
    // smoke spec). Exact match: a case-insensitive regex also hits the combobox
    // trigger (aria-label "from location"), causing a strict-mode violation.
    await expect(page.getByText("Bulk Move Inventory")).toBeVisible();
    await expect(
      page.getByText("From Location", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("To Location", { exact: true })).toBeVisible();

    // Select source location using combobox
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /from location/i }),
      sourceName,
    );

    // Should show items at the source location (wait for items to load)
    await expect(page.getByText(`Items at ${sourceName}`)).toBeVisible();
    await expect(page.getByText(productName)).toBeVisible({ timeout: 10000 });
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
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /from location/i }),
      sourceName,
    );

    // Wait for items to load (Select All button only appears when items exist)
    await expect(page.getByText(`Items at ${sourceName}`)).toBeVisible();
    const selectAllButton = page.getByRole("button", { name: /Select All/i });
    await expect(selectAllButton).toBeVisible({ timeout: 10000 });

    // Click Select All
    await selectAllButton.click();

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
