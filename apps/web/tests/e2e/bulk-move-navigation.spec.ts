import { expect, test } from "@playwright/test";

test.describe("Bulk Move Inventory - Navigation", () => {
  test("can navigate to bulk move page", async ({ page }) => {
    await page.goto("/inventory/bulk-move");
    await page.waitForLoadState("networkidle");

    // CardTitle renders as a div, not a heading - use getByText
    await expect(page.getByText("Bulk Move Inventory")).toBeVisible();
    // Exact match: a case-insensitive regex also hits the combobox trigger
    // (aria-label "from location"), causing a strict-mode violation.
    await expect(
      page.getByText("From Location", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("To Location", { exact: true })).toBeVisible();
  });
});
