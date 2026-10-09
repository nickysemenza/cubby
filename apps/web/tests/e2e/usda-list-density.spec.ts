import { ROW_DENSITY } from "~/ui/data-table/density";

import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// The virtualizer positions rows at ROW_DENSITY.rowHeight; a cell that stacks
// lines (brand/category/UPC, nutrient chips over a count, the full conversion
// grid) grows the painted row past it and scrolling jumps.
test("USDA table rows paint at the fixed virtualized row height", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, "/usda");
  const table = page.getByRole("table", { name: "USDA Foods Table" });
  const branded = table.getByRole("row").filter({
    hasText: "Synthetic granola bar",
  });
  await expect(branded).toContainText("Synthetic Foods Co");
  await expect(branded).toContainText("299000000106");
  const rows = table.getByRole("row").filter({ hasText: "Synthetic" });
  await expect(rows).not.toHaveCount(0);
  const heights = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height),
  );
  for (const height of heights)
    expect(height).toBeLessThanOrEqual(ROW_DENSITY.rowHeight + 1);
});
