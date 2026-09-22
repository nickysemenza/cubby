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

// Phone half of `declared-record-lists.spec.ts`: identities, hrefs, and
// relationship links are asserted once there; this checks only that the same
// records render as phone cards with their amounts and that the phone view
// menu reaches the List presentation without widening the page. Per-column
// rendering itself is guarded by `entity-display.<entity>.unit.test.tsx`.
test("declared record lists render as phone cards with amounts", async ({
  page,
}) => {
  const name = `Record mobile ${Date.now()}`;
  const fixture = await seedRecordListDisplayPrerequisite(page, name);

  await gotoAuthenticatedPage(
    page,
    `/purchases?q=${encodeURIComponent(fixture.orderId)}`,
  );
  // The card shows both the stated and the computed total; either proves it.
  await expect(
    page
      .getByRole("listitem")
      .filter({
        has: page.getByRole("link", { name: fixture.orderId, exact: true }),
      })
      .getByText("$12.34", { exact: true })
      .first(),
  ).toBeVisible();

  await gotoAuthenticatedPage(
    page,
    `/expenses?q=${encodeURIComponent(`${name} expense`)}`,
  );
  const expenseCard = page.getByRole("listitem").filter({
    has: page.getByRole("link", { name: `${name} expense`, exact: true }),
  });
  await expect(expenseCard).toHaveCount(1);
  await expect(expenseCard.getByText("$12.34", { exact: true })).toBeVisible();
  await expect(
    expenseCard.getByRole("link", { name: `${name} product`, exact: true }),
  ).toBeVisible();

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
    page.getByRole("link", { name: `${name} shelf`, exact: true }),
  ).toBeVisible();
  await expectViewportBounded(page);
});
