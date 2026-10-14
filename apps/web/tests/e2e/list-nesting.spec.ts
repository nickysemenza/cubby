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
