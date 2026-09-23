import {
  seedConcurrently,
  seedLocationPrerequisite,
  seedProductPrerequisite,
  seedStaplePlanningPrerequisite,
} from "./e2e-fixtures";
import { escapeRegExp, gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("browser Back restores the search query and scroll", async ({
  page,
}, testInfo) => {
  await gotoAuthenticatedPage(page, "/search");
  const name = uniqueName(testInfo, "Search workflow whole wheat flour");
  await seedConcurrently(
    Array.from({ length: 14 }, (_, index) => index),
    (index) => seedProductPrerequisite(page, { name: `${name} ${index}` }),
  );
  const input = page.getByRole("searchbox", { name: "Search Cubby" });
  await input.fill(name);
  await expect(page).toHaveURL(/q=Search/);
  const results = page.getByRole("link", {
    name: new RegExp(escapeRegExp(name)),
  });
  await expect(results).toHaveCount(14);
  await results.last().scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore).toBeGreaterThan(0);
  await results.last().click();
  await expect(page).toHaveURL(/\/products\/PRD-/);
  await expect(
    page.getByRole("heading", { name: new RegExp(escapeRegExp(name)) }),
  ).toBeVisible();
  await page.goBack();
  await expect(input).toHaveValue(name);
  await expect(input).not.toBeFocused();
  await expect(results.last()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeCloseTo(scrollBefore, 0);
});

test("create dialog validation and parent picker remain reachable", async ({
  page,
}, testInfo) => {
  const parentName = uniqueName(testInfo, "Parent pantry");
  // Locations are created in the list's dialog; `?create=true` is the
  // addressable way in (see CreateDialogAction).
  await gotoAuthenticatedPage(page, "/locations?create=true");
  await seedLocationPrerequisite(page, parentName);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    dialog.locator('[aria-invalid="true"]').first(),
  ).toBeInViewport();
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Pantry");
  const picker = dialog.getByRole("combobox", { name: /Parent location/i });
  await picker.fill(parentName);
  await page
    .getByRole("option", { name: new RegExp(`^${escapeRegExp(parentName)}`) })
    .click();
  await expect(picker).toHaveValue(`${parentName} — room`);
  await expect(
    dialog.getByRole("button", { name: /^Clear parent location/i }),
  ).toBeVisible();
});

test("recipe scaling and shopping checkmarks keep their existing behavior", async ({
  page,
}, testInfo) => {
  const staple = uniqueName(testInfo, "Recipe oats");
  const { recipe } = await seedStaplePlanningPrerequisite(page, staple);
  await gotoAuthenticatedPage(page, `/recipes/${recipe.id}`);
  await page.getByRole("button", { name: "Scale 2×", exact: true }).click();
  await expect(page).toHaveURL(/scale=2/);
  await gotoAuthenticatedPage(
    page,
    "/meals/shopping-list?from=2026-09-09&to=2026-09-09",
  );
  const check = page.getByRole("checkbox", {
    name: `Check ${staple}`,
    exact: true,
  });
  await check.check();
  await expect(check).toBeChecked();
  await check.uncheck();
  await expect(check).not.toBeChecked();
});

test("expense quick-add submits from the desktop dialog", async ({ page }) => {
  const name = `e2e expense ${Date.now()}`;
  await gotoAuthenticatedPage(page, "/expenses");
  await page.getByRole("button", { name: "New", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("spinbutton", { name: "Cost" }).fill("12.34");
  await dialog.getByPlaceholder("Select cost type").click();
  await page.getByRole("option", { name: "Materials", exact: true }).click();
  await dialog.getByPlaceholder("Select trade").click();
  await page.getByRole("option", { name: "Other", exact: true }).click();
  await dialog.getByRole("button", { name: /^Create$/ }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
});
