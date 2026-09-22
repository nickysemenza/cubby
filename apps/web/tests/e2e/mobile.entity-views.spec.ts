import { seedRecordListDisplayPrerequisite } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("columns stay operable inside the phone viewport", async ({ page }) => {
  await gotoAuthenticatedPage(page, "/products");
  // The phone band's `Filter` sheet carries Columns in its footer — there is
  // no standalone Display/Columns trigger in the page-mode phone band.
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("button", { name: "Columns" }).click();

  const settings = page.getByRole("dialog", { name: "Columns" });
  await expect(settings).toBeInViewport();
  const priceRow = settings.locator('[data-column-id="price"]');
  await priceRow.scrollIntoViewIfNeeded();
  await priceRow.getByRole("button", { name: "Actions for Price" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Hide Price" }),
  ).toBeInViewport();
  await expectViewportBounded(page);
});

// Mobile-viewport half of the desktop SSR/navigation proof in
// `declared-record-lists.spec.ts`: same fixture, same cross-page identity and
// relationship links, checked under the phone chrome instead of desktop.
// Per-column rendering itself is guarded by
// `entity-display.<entity>.unit.test.tsx`.
test("declared record lists retain identities, relationships and amounts on mobile", async ({
  page,
}) => {
  const name = `Record mobile ${Date.now()}`;
  const fixture = await seedRecordListDisplayPrerequisite(page, name);

  await gotoAuthenticatedPage(
    page,
    `/purchases?q=${encodeURIComponent(fixture.orderId)}`,
  );
  const purchase = page.getByRole("link", {
    name: fixture.orderId,
    exact: true,
  });
  await expect(purchase).toHaveCount(1);
  await expect(purchase).toHaveAttribute(
    "href",
    `/purchases/${fixture.purchase.id}`,
  );
  // The card shows both the stated and the computed total; either proves it.
  await expect(
    page
      .getByRole("listitem")
      .filter({ has: purchase })
      .getByText("$12.34", { exact: true })
      .first(),
  ).toBeVisible();

  await gotoAuthenticatedPage(
    page,
    `/expenses?q=${encodeURIComponent(`${name} expense`)}`,
  );
  const expense = page.getByRole("link", {
    name: `${name} expense`,
    exact: true,
  });
  await expect(expense).toHaveCount(1);
  const expenseRecord = page.getByRole("listitem").filter({ has: expense });
  await expect(
    expenseRecord.getByText("$12.34", { exact: true }),
  ).toBeVisible();
  await expect(
    expenseRecord.getByRole("link", { name: `${name} product`, exact: true }),
  ).toHaveAttribute("href", `/products/${fixture.product.id}`);

  // The parent relationship is visible in both table rows and mobile cards;
  // Children remains hidden by default in the existing display preferences.
  await gotoAuthenticatedPage(
    page,
    `/locations?name=${encodeURIComponent(`${name} shelf`)}`,
  );
  await page.getByRole("button", { name: /^Locations view:/ }).click();
  await page.getByRole("menuitem", { name: "List", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Locations view: List", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `${name} room · room`, exact: true }),
  ).toHaveAttribute("href", `/locations/${fixture.location.id}`);
  await expect(
    page.getByRole("link", { name: `${name} shelf`, exact: true }),
  ).toHaveAttribute("href", `/locations/${fixture.child.id}`);
  await expectViewportBounded(page);
});
