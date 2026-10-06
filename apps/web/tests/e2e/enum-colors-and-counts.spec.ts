import { dashboardCountsOut } from "@cubby/schemas/dashboard";
import { createFixture } from "./fixtures-core";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("declared expectation colors and spending category navigation counts", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = `Synthetic color category ${Date.now()}`;
  const category = await createFixture(page, "spendingCategory", {
    name,
    evidenceExpectation: "unknown",
    productExpectation: "required",
  });
  await createFixture(page, "spendingCategory", {
    name: `${name} resolved`,
    evidenceExpectation: "required",
    productExpectation: "not_expected",
  });
  await gotoAuthenticatedPage(
    page,
    `/spending-categories?q=${encodeURIComponent(name)}`,
  );
  const record = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
  const unknown = record.locator(
    '[data-cell-col="evidenceExpectation"] [style*="--enum-pill-color"]',
  );
  const expected = record.locator(
    '[data-cell-col="productExpectation"] [style*="--enum-pill-color"]',
  );
  await expect(unknown).toHaveText("Unclassified");
  await expect(expected).toHaveText("Expected");
  await expect(unknown).toHaveAttribute(
    "style",
    /--enum-pill-color: var\(--warning\)/,
  );
  await expect(expected).toHaveAttribute(
    "style",
    /--enum-pill-color: var\(--brand-domain-house\)/,
  );
  const counts = await page.request.get("/api/v1/dashboard/counts");
  expect(counts.ok()).toBe(true);
  const body = dashboardCountsOut.parse(await counts.json());
  expect(body.spendingCategory).toBeGreaterThan(0);
  const categoryNav = page.getByRole("link", {
    name: new RegExp(`^Spending Categories.*${body.spendingCategory} records`),
  });
  await expect(categoryNav).toBeVisible();
  await categoryNav.scrollIntoViewIfNeeded();
  await expect(categoryNav).toBeInViewport();
  await testInfo.attach("expectation-palette", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoAuthenticatedPage(page, `/spending-categories/${category.id}`);
  await expect(
    page.getByText("Unclassified", { exact: true }).first(),
  ).toBeVisible();
  const mobileBadge = page
    .locator('[style*="--enum-pill-color: var(--warning)"]')
    .first();
  await expect(mobileBadge).toBeVisible();
  await mobileBadge.scrollIntoViewIfNeeded();
  await expect(mobileBadge).toBeInViewport();
  await testInfo.attach("mobile-expectation-palette", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  });
});
