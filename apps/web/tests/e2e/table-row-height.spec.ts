import type { Page } from "@playwright/test";
import { z } from "zod";

import { ROW_DENSITY } from "~/ui/data-table/density";

import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// The virtualizer positions rows at ROW_DENSITY.rowHeight; a cell that stacks
// lines past it (brand/category/UPC, nutrient chips over a count, reference
// chips wrapping onto a third line beside a "View all" link) grows the
// painted row and scrolling jumps.
async function expectRowsAtDensity(page: Page, table: string, text: string) {
  const rows = page
    .getByRole("table", { name: table })
    .getByRole("row")
    .filter({ hasText: text });
  await expect(rows.first()).toBeVisible();
  const heights = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height),
  );
  for (const height of heights)
    expect(height).toBeLessThanOrEqual(ROW_DENSITY.rowHeight + 1);
}

test("USDA rows paint at the fixed virtualized row height", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, "/usda");
  const branded = page
    .getByRole("table", { name: "USDA Foods Table" })
    .getByRole("row")
    .filter({ hasText: "Synthetic granola bar" });
  await expect(branded).toContainText("Synthetic Foods Co");
  await expect(branded).toContainText("299000000106");
  await expectRowsAtDensity(page, "USDA Foods Table", "Synthetic");
});

test("multi-reference list cells stay within the row height", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const create = async (
    path: string,
    data: z.infer<ReturnType<typeof z.json>>,
  ) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      headers: { Origin: baseURL! },
      data,
    });
    expect(response.status(), await response.text()).toBe(201);
    return z
      .object({ item: z.object({ id: z.string() }) })
      .parse(await response.json()).item.id;
  };
  const name = `Synthetic row height ${Date.now()}`;
  const spending = await create("spending-categories", { name });
  for (const child of ["pantry", "produce", "bakery", "frozen"])
    await create("product-categories", {
      name: `${name} ${child}`,
      spendingCategoryMode: "mapped",
      spendingCategoryId: spending,
    });
  await gotoAuthenticatedPage(page, "/spending-categories");
  const row = page.getByRole("row").filter({ hasText: name });
  // However many chips fit two lines, the rest are counted, never dropped.
  const overflow = row.locator("[data-chip-overflow]");
  await expect(overflow).toHaveText(/^\+\d+$/);
  const hidden = Number((await overflow.textContent())?.slice(1));
  await expect(row.locator("[data-chip]")).toHaveCount(4 - hidden);
  await expect(row.getByRole("link", { name: "View all" })).toBeVisible();
  await expectRowsAtDensity(
    page,
    (await page.getByRole("table").first().getAttribute("aria-label"))!,
    name,
  );
});
