import type { Locator, Page } from "@playwright/test";

import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import {
  seedProductCategoryPrerequisite,
  seedProductPrerequisite,
} from "./fixtures-catalog";
import { createEntityFixture } from "./fixtures-core";

// Columns are as narrow as their values (docs/agents/web-ui-reference.md):
// - a header's sort arrow and source icon take no width until it is hovered;
// - a count of one entity's records heads its column with that entity's icon;
// - a date prints "Sep 3" over "’25 · 1y ago";
// - the explanation ⓘ shows only on the active row and reserves no width;
// - no column grows past its kind's cap to fit one long value.

const width = async (locator: Locator) =>
  Math.round((await locator.boundingBox())?.width ?? 0);

const header = (page: Page, id: string) =>
  page.locator(`thead th[data-column-id="${id}"]`);

/** A household day about 400 days ago and its stacked-cell form. */
function lastYearDay() {
  const day = new Date(Date.now() - 400 * 86_400_000);
  const iso = day.toISOString().slice(0, 10);
  const month = day.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return {
    iso,
    primary: `${month} ${day.getUTCDate()}`,
    secondary: `’${iso.slice(2, 4)} · 1y ago`,
  };
}

test("product table columns hug their values", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const suffix = Date.now();
  const name = `Synthetic density oats ${suffix}`;
  const categoryName = `Synthetic pantry staples and long-keeping dry goods ${suffix}`;
  const category = await seedProductCategoryPrerequisite(page, {
    name: categoryName,
  });
  const product = await seedProductPrerequisite(page, {
    name,
    categoryId: category.id,
  });
  const day = lastYearDay();
  await createEntityFixture(page, "expense", {
    name: `Synthetic density line ${suffix}`,
    productId: product.id,
    productQuantity: 1,
    cost: 12,
    date: day.iso,
    costType: "materials",
    trade: "other",
  });
  await gotoAuthenticatedPage(
    page,
    `/products?view=table&name=${encodeURIComponent(name)}`,
  );
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();

  // A record count heads its column with the counted entity's icon.
  const expenses = header(page, "expenseCount");
  await expect(
    expenses.getByRole("button", { name: "Sort by Expense count" }),
  ).toBeVisible();
  await expect(expenses.locator("[data-header-count] svg")).toBeVisible();
  await expect(expenses.locator("[data-header-count]")).toContainText("#");
  await expect(expenses.locator("[data-header-label]")).toHaveAttribute(
    "title",
    "Expense count",
  );
  // A loading bar no longer sets the fit of a column filled in later.
  await expect.poll(() => width(expenses)).toBeLessThanOrEqual(40);

  // Hover-only header chrome reserves nothing.
  const purchaseDate = header(page, "purchaseDate");
  await expect(purchaseDate.locator("[data-field-provenance]")).toBeHidden();
  await purchaseDate.hover();
  await expect(purchaseDate.locator("[data-field-provenance]")).toBeVisible();

  // The year moves to the distance line.
  const dateCell = row.locator('[data-cell-col="purchaseDate"]');
  const lines = dateCell.locator("[data-stacked-line]");
  await expect(lines).toHaveText([day.primary, day.secondary]);
  await expect.poll(() => width(purchaseDate)).toBeLessThanOrEqual(84);

  // The explanation shows only on the active row, over the cell.
  await page.mouse.move(0, 0);
  const countCell = row.locator('[data-cell-col="expenseCount"]');
  // The explanation's frame wraps the relation workbench's.
  const value = countCell.locator("[data-cell-value]").first();
  const idle = await width(value);
  await countCell.hover();
  const explain = countCell.getByRole("button", { name: /expense count/i });
  await expect(explain).toBeVisible();
  expect(await width(value)).toBe(idle);
  expect(idle).toBe(
    await width(countCell.locator("[data-cell-frame]").first()),
  );

  // One long reference name no longer sets its column's width.
  const categoryHeader = header(page, "categoryId");
  await expect.poll(() => width(categoryHeader)).toBeLessThanOrEqual(160);
  await row.locator('[data-cell-col="categoryId"]').hover();
  await expect(page.locator("[data-cell-spill-overlay]")).toContainText(
    categoryName,
  );
});
