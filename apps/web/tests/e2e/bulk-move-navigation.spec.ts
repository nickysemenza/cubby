import { expect, test } from "@playwright/test";

test.describe("Bulk Move Inventory - Navigation", () => {
  test("can navigate to bulk move page", async ({ page }) => {
    await page.goto("/inventory/bulk-move");
    await page.waitForLoadState("networkidle");

    // CardTitle renders as a div, not a heading - use getByText
    await expect(page.getByText("Bulk Move Inventory")).toBeVisible();
    await expect(page.getByText(/From Location/i)).toBeVisible();
    await expect(page.getByText(/To Location/i)).toBeVisible();
  });
});
