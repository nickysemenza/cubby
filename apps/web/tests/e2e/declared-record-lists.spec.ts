import {
  seedPurchaseHeicAttachment,
  seedRecordListDisplayPrerequisite,
} from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Desktop-only: this is the SSR + cross-page navigation proof for declared
// record-list columns. Per-column rendering itself is guarded by
// `entity-display.<entity>.unit.test.tsx`.
test("declared record lists retain identities, relationships and amounts on desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const name = `Record desktop ${Date.now()}`;
  const fixture = await seedRecordListDisplayPrerequisite(page, name);
  await page.goto(`/purchases?q=${encodeURIComponent(fixture.orderId)}`);
  const purchase = page.getByRole("link", {
    name: fixture.orderId,
    exact: true,
  });
  await expect(purchase).toHaveCount(1);
  await expect(purchase).toHaveAttribute(
    "href",
    `/purchases/${fixture.purchase.id}`,
  );
  await expect(
    page
      .getByRole("row")
      .filter({ has: purchase })
      .locator('[data-cell-col="statedTotal"]'),
  ).toHaveText("$12.34");
  await expect(
    page.getByRole("button", {
      name: "Reorder reconciliation column",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    page.getByText(`${name} purchase notes`, { exact: true }),
  ).toBeVisible();
  await page.goto(`/expenses?q=${encodeURIComponent(`${name} expense`)}`);
  const expense = page.getByRole("link", {
    name: `${name} expense`,
    exact: true,
  });
  await expect(expense).toHaveCount(1);
  const expenseRecord = page.getByRole("row").filter({ has: expense });
  await expect(
    expenseRecord.getByText("$12.34", { exact: true }),
  ).toBeVisible();
  await expect(
    expenseRecord.getByRole("link", { name: `${name} product`, exact: true }),
  ).toHaveAttribute("href", `/products/${fixture.product.id}`);
  await expect(
    page.getByRole("columnheader").filter({
      has: page.getByRole("button", {
        name: "Reorder purchaseId column",
        exact: true,
      }),
    }),
  ).toContainText("Purchase");
  // The parent relationship is visible in both table rows and mobile cards;
  // Children remains hidden by default in the existing display preferences.
  await gotoAuthenticatedPage(
    page,
    `/locations?name=${encodeURIComponent(`${name} shelf`)}`,
  );
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "List view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("columnheader").filter({
      has: page.getByRole("button", {
        name: "Reorder name column",
        exact: true,
      }),
    }),
  ).toContainText("Location");
  await expect(
    page.getByRole("link", { name: `${name} room · room`, exact: true }),
  ).toHaveAttribute("href", `/locations/${fixture.location.id}`);
  await expect(
    page.getByRole("link", { name: `${name} shelf`, exact: true }),
  ).toHaveAttribute("href", `/locations/${fixture.child.id}`);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1281);
});

test("purchase detail renders an attached HEIC instead of the empty image state", async ({
  page,
}) => {
  const fixture = await seedPurchaseHeicAttachment(
    page,
    `Purchase HEIC ${Date.now()}`,
  );
  await page.goto(`/purchases/${fixture.purchase.id}`);
  await expect(page.getByText("No images", { exact: true })).toHaveCount(0);
  await expect(
    page.locator("#images").getByRole("img", { name: fixture.filename }),
  ).toHaveCount(1);
});
