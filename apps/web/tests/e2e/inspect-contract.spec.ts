import {
  seedFinancialAccountPrerequisite,
  seedProductPrerequisite,
} from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Each test creates human-readable records in the shared E2E database. A retry
// would collide with those records and could make a failed interaction appear
// to pass against the wrong row.
test.describe.configure({ retries: 0 });

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
  await expect(table).toBeVisible({ timeout: 15000 });
  const row = table.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("checkbox", { name: "Select row" }).click();

  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  const inspect = page.getByRole("button", { name: "Inspect", exact: true });
  await expect(inspect).toBeVisible();
  await inspect.click();

  await expect(page.locator("[data-desktop-inspector]")).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Product inspector" }),
  ).toBeVisible();
  await expect(row.getByRole("checkbox", { name: "Select row" })).toBeChecked();
});

test("Inspect is unavailable for a multi-selection while both rows stay selected", async ({
  page,
}) => {
  const prefix = `Inspect contract multi ${Date.now()}`;
  const first = `${prefix} first`;
  const second = `${prefix} second`;
  await seedProductPrerequisite(page, { name: first });
  await seedProductPrerequisite(page, { name: second });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(prefix)}`,
  );

  const table = page.getByRole("table", { name: /Products table/i });
  await expect(table).toBeVisible({ timeout: 15000 });
  for (const name of [first, second]) {
    await table
      .getByRole("row")
      .filter({ hasText: name })
      .getByRole("checkbox", { name: "Select row" })
      .click();
  }

  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect", exact: true }),
  ).toHaveCount(0);
  await expect(
    table
      .getByRole("row")
      .filter({ hasText: first })
      .getByRole("checkbox", { name: "Select row" }),
  ).toBeChecked();
  await expect(
    table
      .getByRole("row")
      .filter({ hasText: second })
      .getByRole("checkbox", { name: "Select row" }),
  ).toBeChecked();
});

test("a phone single-selection Inspect action opens the canonical Product detail", async ({
  page,
}) => {
  const name = `Inspect contract phone ${Date.now()}`;
  const product = await seedProductPrerequisite(page, { name });
  await page.setViewportSize({ width: 430, height: 932 });
  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(name)}`,
  );

  const card = page.getByRole("listitem").filter({ hasText: name });
  await expect(card).toBeVisible({ timeout: 15000 });
  // Phone lists enter selection mode through the native long-press gesture.
  // Dispatch on the interactive row shell: an event created on the outer
  // virtual-list item does not travel down into its child touch handlers.
  const cardBody = card.getByRole("group");
  await cardBody.dispatchEvent("touchstart");
  await page.waitForTimeout(550);
  await cardBody.dispatchEvent("touchend");
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/products/${product.id}$`));
  await expect(page.getByRole("heading", { name })).toBeVisible({
    timeout: 15000,
  });
});

test("a standard EntityListPage roster opens the generic inspector", async ({
  page,
}) => {
  const name = `Inspect contract account ${Date.now()}`;
  await seedFinancialAccountPrerequisite(page, name);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, "/financial-accounts");

  const table = page.getByRole("table").first();
  await expect(table).toBeVisible({ timeout: 15000 });
  const row = table.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("checkbox", { name: "Select row" }).click();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();

  await expect(
    page.getByRole("complementary", {
      name: /Financial account inspector/i,
    }),
  ).toBeVisible();
});
