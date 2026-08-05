import { expect, test } from "@playwright/test";

/**
 * The shopping list's renderer param has to survive the page's own controls.
 *
 * `onRangeChange` used to pass a plain object to `search`, which REPLACES the
 * whole search state — harmless while from/to were the only params, and a
 * silent bug the moment `view` existed: pick Matrix, nudge a date, and you're
 * back on the list with no indication why.
 *
 * Deliberately data-free. What the matrix renders with real columns is pinned
 * by shopping-matrix.unit.test.tsx; what's only checkable in a browser is this
 * URL round-trip, and it holds with or without meals in range.
 */
test("keeps the matrix renderer when the date range changes", async ({
  page,
}) => {
  await page.goto("/meals/shopping-list?view=matrix");
  await page.waitForLoadState("networkidle");

  const matrixToggle = page.getByRole("button", { name: "Matrix view" });
  await expect(matrixToggle).toHaveAttribute("aria-pressed", "true");

  // `exact` matters: accessible-name matching is substring, and the footer's
  // "GitHub repository" link contains "to".
  await page.getByLabel("From", { exact: true }).fill("2026-06-01");
  await expect(page).toHaveURL(/from=2026-06-01/);
  await expect(page).toHaveURL(/view=matrix/);
  await expect(matrixToggle).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("To", { exact: true }).fill("2026-06-30");
  await expect(page).toHaveURL(/to=2026-06-30/);
  await expect(page).toHaveURL(/view=matrix/);
});

test("drops the renderer param when switching back to the default", async ({
  page,
}) => {
  // The default maps to `undefined` so `stripSearchParams` keeps a plain link
  // clean — `?view=list` should never persist.
  await page.goto("/meals/shopping-list?view=matrix&from=2026-06-01");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "List view" }).click();

  await expect(page).not.toHaveURL(/view=/);
  await expect(page).toHaveURL(/from=2026-06-01/);
});
