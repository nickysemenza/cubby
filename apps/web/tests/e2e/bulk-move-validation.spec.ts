import {
  createLocation,
  selectComboboxItem,
  waitForFormHydration,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test.describe("Bulk Move Inventory - Validation", () => {
  test("disables the source location as a target", async ({ page }) => {
    const timestamp = Date.now();
    const locationName = `E2E Same Location ${timestamp}`;

    await createLocation(page, locationName);

    await page.goto("/inventory/bulk-move");
    await waitForFormHydration(page);

    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /from location/i }),
      locationName,
    );

    const target = page.getByRole("combobox", { name: /to location/i });
    await expect(async () => {
      await target.click();
      await expect(target).toHaveAttribute("aria-expanded", "true");
    }).toPass({ timeout: 5000 });
    await target.fill(locationName);

    const option = page.getByRole("option", {
      name: new RegExp(`^${locationName}`),
    });
    await expect(option).toBeVisible({ timeout: 10000 });
    await expect(option).toHaveAttribute("aria-disabled", "true");
    await expect(option).toContainText("Already the current location");
  });
});
