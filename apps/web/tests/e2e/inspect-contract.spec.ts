import { seedProductPrerequisite } from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("a single Product selection exposes Inspect and opens the desktop dock", async ({
  page,
}) => {
  const name = `Inspect contract product ${Date.now()}`;
  await seedProductPrerequisite(page, { name });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(name)}`,
  );

  const table = page.getByRole("table", { name: /Products table/i });
  const row = table.getByRole("row").filter({ hasText: name });
  await row.getByRole("checkbox", { name: "Select row" }).click();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();

  await expect(page.locator("[data-desktop-inspector]")).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Product inspector" }),
  ).toBeVisible();
  await expect(row.getByRole("checkbox", { name: "Select row" })).toBeChecked();
});

// Regression: flipping row activity while a control inside the row holds focus
// once remounted the selection checkbox and dropped the interaction. Keyboard
// focus on a control now activates its row (so Tab users reach the row's rail
// controls); the checkbox must keep focus and still toggle.
test("keyboard focus on a row checkbox keeps focus and selects the row", async ({
  page,
}) => {
  const name = `Keyboard select product ${Date.now()}`;
  await seedProductPrerequisite(page, { name });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(name)}`,
  );
  const row = page
    .getByRole("table", { name: /Products table/i })
    .getByRole("row")
    .filter({ hasText: name });
  const checkbox = row.getByRole("checkbox", { name: "Select row" });
  await expect(checkbox).toBeVisible();
  // Keyboard modality first, so the programmatic focus below is focus-visible.
  await page.keyboard.press("Tab");
  await checkbox.focus();
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeFocused();
});
