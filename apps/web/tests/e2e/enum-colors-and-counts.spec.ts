import type { Locator } from "@playwright/test";
import { dashboardCountsOut } from "@cubby/schemas/dashboard";
import { createFixture } from "./fixtures/core";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("declared expectation colors and spending category navigation counts", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Utility icons must inherit active link ink on desktop and phone; unknown
  // classifications stay neutral rather than reading as an urgent condition.
  await gotoAuthenticatedPage(page, "/");
  await expectActiveHomeIcon("Home");
  const name = `Synthetic color category ${Date.now()}`;
  const category = await createFixture(page, "spendingCategory", {
    name,
    itemizationExpectation: "unknown",
    productExpectation: "required",
  });
  await createFixture(page, "spendingCategory", {
    name: `${name} resolved`,
    itemizationExpectation: "required",
    productExpectation: "not_expected",
  });
  await gotoAuthenticatedPage(
    page,
    `/spending-categories?q=${encodeURIComponent(name)}`,
  );
  const record = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
  // Compiled status choices keep readable labels and their explicit glyph tones.
  const unknown = record.locator(
    '[data-cell-col="itemizationExpectation"] [data-enum-role="status"]',
  );
  const expected = record.locator(
    '[data-cell-col="productExpectation"] [data-enum-role="status"]',
  );
  await expect(unknown).toHaveText("Unclassified");
  await expect(expected).toHaveText("Expected");
  await expectGlyphTone(unknown, "--brand-neutral-status");
  await expectGlyphTone(expected, "--brand-info");
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

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoAuthenticatedPage(page, `/spending-categories/${category.id}`);
  await expect(
    page.getByText("Unclassified", { exact: true }).first(),
  ).toBeVisible();
  // Field suggestions wrap each suggestible value once they load, which
  // remounts it; scroll the settled badge, not the one being replaced.
  await expect(
    page.getByRole("button", { name: /^Checking suggestions/ }),
  ).toHaveCount(0);
  const mobileBadge = page
    .locator('[data-enum-role="status"]', {
      hasText: "Unclassified",
    })
    .first();
  await expect(mobileBadge).toBeVisible();
  await mobileBadge.scrollIntoViewIfNeeded();
  await expect(mobileBadge).toBeInViewport();
  await gotoAuthenticatedPage(page, "/");
  await expectActiveHomeIcon("Today");

  async function expectGlyphTone(pill: Locator, token: string) {
    const color = await page.evaluate((token) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, token);
    await expect(pill.locator("svg[data-option-glyph]")).toHaveCSS(
      "color",
      color,
    );
  }

  async function expectActiveHomeIcon(label: string) {
    const home = page.getByRole("link", { name: label, exact: true }).first();
    await expect(home).toHaveAttribute("aria-current", "page");
    const ink = await home.evaluate(
      (element) => getComputedStyle(element).color,
    );
    await expect(home.locator("svg").first()).toHaveCSS("color", ink);
  }
});
