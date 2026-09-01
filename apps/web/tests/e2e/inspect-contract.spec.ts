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
