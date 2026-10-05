import {
  seedLocationPrerequisite,
  seedProductPrerequisite,
} from "./fixtures-catalog";
import { createEntityFixture, seedConcurrently } from "./fixtures-core";
import { seedStaplePlanningPrerequisite } from "./fixtures-recipes";
import { escapeRegExp, gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("recommendations workbench direct entry shows guidance", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/recommendations/workbench");
  await expect(
    page.getByRole("heading", { name: "Recommendations Workbench" }),
  ).toBeVisible();
  await expect(
    page.getByText("Open this workbench from a current recommendation."),
  ).toBeVisible();
});

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

// A Product rename rewrites the search text of every record that embeds it
// (`mutation-side-effects.ts` `searchDependents`): its placements, the Tasks
// that inherit it as their subject, and the Wishes that list it as a candidate.
test("search finds a renamed Product through its Inventory, Task, and Wish", async ({
  page,
  baseURL,
}, testInfo) => {
  const oldName = uniqueName(testInfo, "Fanout tarp");
  const newName = uniqueName(testInfo, "Fanout awning");
  const choreName = uniqueName(testInfo, "Gutter chore");
  const subchoreName = uniqueName(testInfo, "Gutter subchore");
  const wishName = uniqueName(testInfo, "Shade wish");
  const location = await createEntityFixture(page, "location", {
    name: uniqueName(testInfo, "Fanout shed"),
  });
  const product = await createEntityFixture(page, "product", {
    name: oldName,
  });
  await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 1, unit: "each" },
  });
  const chore = await createEntityFixture(page, "task", {
    name: choreName,
    trade: "other",
    subjectProductId: product.id,
  });
  // No subject of its own: it inherits the parent's Product.
  await createEntityFixture(page, "task", {
    name: subchoreName,
    trade: "other",
    parentTaskId: chore.id,
  });
  await createEntityFixture(page, "wish", {
    name: wishName,
    candidateProductIds: [product.id],
  });

  const renamed = await page.request.patch(`/api/v1/products/${product.id}`, {
    headers: { Origin: baseURL! },
    data: { name: newName },
  });
  expect(renamed.status(), await renamed.text()).toBe(200);

  const expectHits = async (query: string, type: string, titles: string[]) => {
    await gotoAuthenticatedPage(
      page,
      `/search?${new URLSearchParams({ q: query, type })}`,
    );
    for (const title of titles)
      await expect(
        page.getByRole("link", { name: title, exact: true }),
      ).toBeVisible();
  };
  await expectHits(newName, "inventory", [newName]);
  await expectHits(newName, "task", [choreName, subchoreName]);
  await expectHits(newName, "wish", [wishName]);

  for (const type of ["product", "inventory", "task", "wish"]) {
    await gotoAuthenticatedPage(
      page,
      `/search?${new URLSearchParams({ q: oldName, type })}`,
    );
    await expect(page.getByText("No direct matches.")).toBeVisible();
  }
});

// A dialog-created entity has no form page: `/new` is generated to redirect
// to the list's capture dialog, not to fall through to `/locations/$shortcode`.
test("a dialog entity's /new link opens its create dialog on the list", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/locations/new");
  await expect(page).toHaveURL(/\/locations\?create=true$/u);
  await expect(page.getByRole("dialog")).toBeVisible();
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
  const picker = dialog.getByRole("combobox", { name: "Parent", exact: true });
  await picker.fill(parentName);
  await page
    .getByRole("option", { name: new RegExp(`^${escapeRegExp(parentName)}`) })
    .click();
  await expect(picker).toHaveValue(`${parentName} — room`);
  await expect(
    dialog.getByRole("button", { name: "Clear Parent", exact: true }),
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
