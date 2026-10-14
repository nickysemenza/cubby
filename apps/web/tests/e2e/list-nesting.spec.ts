import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { createFixture } from "./fixtures-core";
import { seedActiveResearchHistory } from "./fixtures-photos";

// The server nests a tree list: the browser shows the roots it pages and reads
// an expanded row's children, never nesting loaded pages itself.
test("Runs open flat and nest from the server on request", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sample = await seedActiveResearchHistory(
    page,
    `Nesting vendor ${Date.now()}`,
  );
  await gotoAuthenticatedPage(page, `/runs?vendorId=${sample.vendorId}`);
  const rows = page
    .getByRole("table")
    .getByRole("row")
    .filter({ hasText: sample.name });
  await expect(rows).toHaveCount(2);

  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show nested list" }).click();
  await expect(page).toHaveURL(/[?&]nest=on/);
  await expect(rows).toHaveCount(1);
  await expect(rows.getByLabel("1 nested")).toBeVisible();

  await rows.getByRole("button", { name: "Expand" }).click();
  await expect(rows).toHaveCount(2);

  await page.reload();
  await expect(page).toHaveURL(/[?&]nest=on/);
  await expect(rows).toHaveCount(1);
  await expect(rows.getByLabel("1 nested")).toBeVisible();
});

// A phone has no inline Nested button: the Filter sheet carries the same
// switch, driving the same `nest` URL key and declared default.
test("a phone toggles Runs nested from the Filter sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sample = await seedActiveResearchHistory(
    page,
    `Nesting phone ${Date.now()}`,
  );
  await gotoAuthenticatedPage(page, `/runs?vendorId=${sample.vendorId}`);
  const cards = page.getByRole("listitem").filter({ hasText: sample.name });
  await expect(cards).toHaveCount(2);

  await page.getByRole("button", { name: /^Filter(?: \d+)?$/ }).click();
  const nested = page.getByRole("switch", { name: "Nested" });
  await expect(nested).toHaveAttribute("aria-checked", "false");
  await nested.click();
  await expect(page).toHaveURL(/[?&]nest=on/);
  await expect(nested).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(cards).toHaveCount(1);
  await cards.getByRole("button", { name: "Expand" }).click();
  await expect(cards).toHaveCount(2);

  await page.reload();
  await expect(page).toHaveURL(/[?&]nest=on/);
  await expect(cards).toHaveCount(1);
});

test("a category list renders nested from the server", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const prefix = `Nesting shelf ${Date.now()}`;
  const parent = await createFixture(page, "productCategory", {
    name: `${prefix} pantry`,
  });
  await createFixture(page, "productCategory", {
    name: `${prefix} spices`,
    parentId: parent.id,
  });
  await gotoAuthenticatedPage(
    page,
    `/product-categories?q=${encodeURIComponent(prefix)}`,
  );
  const rows = page
    .getByRole("table")
    .getByRole("row")
    .filter({ hasText: prefix });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(`${prefix} pantry`);
  await rows.getByRole("button", { name: "Expand" }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText(`${prefix} spices`);
});
