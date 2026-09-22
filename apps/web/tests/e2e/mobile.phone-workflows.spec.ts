import {
  seedLocationPrerequisite,
  seedProductPrerequisite,
  seedStaplePlanningPrerequisite,
} from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("Home Screen manifest opens Today without changing the installed app identity", async ({
  request,
}) => {
  const response = await request.get("/manifest.json");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    id: "/inventory/session",
    start_url: "/",
    scope: "/",
    share_target: { action: "/recipes/new" },
  });
});

test("search detail Back retains query and does not reopen the input", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/search");
  const name = "Phone workflow whole wheat flour";
  for (let index = 0; index < 14; index++) {
    await seedProductPrerequisite(page, { name: `${name} ${index}` });
  }
  const input = page.getByRole("searchbox", { name: "Search Cubby" });
  await input.fill(name);
  await expect(page).toHaveURL(/q=Phone/);
  const results = page.getByRole("link", { name: new RegExp(name) });
  await expect(results).toHaveCount(14);
  await results.last().scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore).toBeGreaterThan(0);
  await results.last().click();
  await expect(page).toHaveURL(/\/products\/PRD-/);
  // Back must wait for the detail route to resolve. @tanstack/router-core snapshots
  // the outgoing page's scroll at the NEXT `onBeforeLoad`, keyed by
  // `resolvedLocation`; tapping Back while the pending skeleton is presented
  // records the collapsed skeleton (scrollY 0) over the list offset and the
  // restore below lands at 0. Known upstream limitation, deliberately not patched;
  // Playwright `click()` sends mouse events, so the touchstart intent preload
  // that avoids the skeleton on a real phone does not fire here.
  await expect(
    page.getByRole("heading", { name: new RegExp(name) }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(input).toHaveValue(name);
  await expect(input).not.toBeFocused();
  await expect(results.last()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeCloseTo(scrollBefore, 0);
  await expectViewportBounded(page);
});

test("direct links fall back to the parent and directories remain reachable through More", async ({
  page,
}) => {
  // `/products/new` is gone (product creates in a dialog); `/recipes/new`
  // is the remaining child route with a parent to fall back to.
  await gotoAuthenticatedPage(page, "/recipes/new");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/recipes$/);
  await page.getByRole("button", { name: "More options" }).click();
  const more = page.getByRole("dialog", { name: "More", exact: true });
  await more.getByRole("link", { name: "Records", exact: true }).click();
  await expect(page).toHaveURL(/\/records/);
  const filter = page.getByRole("searchbox", { name: "Find a record type" });
  await filter.fill("products");
  await expect(
    page.getByRole("link", { name: "Products", exact: true }),
  ).toBeVisible();
  await filter.fill("no matching directory");
  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(filter).toHaveValue("");
  await expectViewportBounded(page);
});

test("form validation and picker entry remain reachable", async ({ page }) => {
  // Locations are created in the list's dialog; `?create=true` is the
  // addressable way in (see CreateDialogAction).
  await gotoAuthenticatedPage(page, "/locations?create=true");
  await seedLocationPrerequisite(page, "Phone parent pantry");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    dialog.locator('[aria-invalid="true"]').first(),
  ).toBeInViewport();
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Phone pantry");
  const picker = dialog.getByRole("combobox", { name: /Parent location/i });
  await picker.fill("Phone parent");
  await page.getByRole("option", { name: /Phone parent pantry/ }).click();
  await expect(picker).toHaveValue("Phone parent pantry — room");
  const clear = dialog.getByRole("button", {
    name: /^Clear parent location/i,
  });
  const target = await clear.boundingBox();
  expect(target?.width).toBeGreaterThanOrEqual(44);
  expect(target?.height).toBeGreaterThanOrEqual(44);
  await expectViewportBounded(page);
});

test("recipe scaling and shopping checkmarks keep their existing behavior", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/");
  const { recipe } = await seedStaplePlanningPrerequisite(page, "Phone oats");
  await gotoAuthenticatedPage(page, `/recipes/${recipe.id}`);
  await page.getByRole("button", { name: "Scale 2×", exact: true }).click();
  await expect(page).toHaveURL(/scale=2/);
  await expectViewportBounded(page);
  await gotoAuthenticatedPage(
    page,
    "/meals/shopping-list?from=2026-09-09&to=2026-09-09",
  );
  const check = page.getByRole("checkbox", {
    name: "Check Phone oats",
    exact: true,
  });
  await check.check();
  await expect(check).toBeChecked();
  await check.uncheck();
  await expect(check).not.toBeChecked();
  await expectViewportBounded(page);
});
