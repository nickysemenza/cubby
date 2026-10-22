import { entityApi } from "./support/entity-api";
import type { Page } from "@playwright/test";

import {
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
} from "./support/e2e-helpers";
import { seedStaplePlanningPrerequisite } from "./fixtures/recipes";
import { expect, test } from "./support/e2e-test";

async function openIngredientEditor(page: Page) {
  const checkbox = page.getByRole("checkbox", {
    name: "Usually on hand",
    exact: true,
  });
  await page
    .getByRole("button", { name: "Edit Ingredient", exact: true })
    .click();
  await expect(checkbox).toBeVisible();
  return checkbox;
}

test("usually-on-hand marking persists without inventory", async ({ page }) => {
  const name = `Staple ${Date.now()}`;
  const { ingredient } = await seedStaplePlanningPrerequisite(page, name);
  await gotoAuthenticatedPage(page, `/ingredients/${ingredient.id}`);
  const checkbox = await openIngredientEditor(page);
  await checkbox.check();
  await page.getByRole("button", { name: /Save/ }).click();
  await expect(
    page.getByRole("checkbox", { name: "Usually on hand", exact: true }),
  ).toHaveCount(0);
  await reloadAuthenticatedPage(page);
  const checkedCheckbox = await openIngredientEditor(page);
  await expect(checkedCheckbox).toBeChecked();
});

test("usually-on-hand ingredients appear in planning without inventory", async ({
  page,
}) => {
  const name = `Staple planning ${Date.now()}`;
  const { ingredient } = await seedStaplePlanningPrerequisite(page, name);
  // The preceding test owns the generic checkbox's persisted edit.
  const saved = await entityApi(page.request).update(
    "ingredient",
    ingredient.id,
    { usuallyOnHand: true },
  );
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await gotoAuthenticatedPage(page, "/meals/suggestions");
  const recipeCard = page.getByRole("link", {
    name: new RegExp(`${name} recipe`),
  });
  await expect(recipeCard).toBeVisible();
  await expect(recipeCard.getByText(/^Staples assumed/)).toBeVisible();
  await gotoAuthenticatedPage(
    page,
    "/meals/shopping-list?from=2026-09-09&to=2026-09-09",
  );
  const staples = page.getByRole("region", {
    name: "Usually on hand",
    exact: true,
  });
  await expect(staples.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(
    staples.getByText(/^10\s*g$/).filter({ visible: true }),
  ).toBeVisible();
  await expect(staples.getByRole("checkbox")).toHaveCount(0);
  await reloadAuthenticatedPage(page);
  await expect(staples.getByRole("link", { name, exact: true })).toBeVisible();
});

test("unmarking a usually-on-hand ingredient puts it back on the shopping list", async ({
  page,
}) => {
  const name = `Staple unmark ${Date.now()}`;
  const { ingredient } = await seedStaplePlanningPrerequisite(page, name);
  // The preceding test owns the generic checkbox's persisted edit.
  const saved = await entityApi(page.request).update(
    "ingredient",
    ingredient.id,
    { usuallyOnHand: true },
  );
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await gotoAuthenticatedPage(page, `/ingredients/${ingredient.id}`);
  const checkedCheckbox = await openIngredientEditor(page);
  await expect(checkedCheckbox).toBeChecked();
  await checkedCheckbox.uncheck();
  await page.getByRole("button", { name: /Save/ }).click();
  await expect(
    page.getByRole("checkbox", { name: "Usually on hand", exact: true }),
  ).toHaveCount(0);
  await gotoAuthenticatedPage(
    page,
    "/meals/shopping-list?from=2026-09-09&to=2026-09-09",
  );
  await expect(
    page
      .getByRole("region", { name: "To buy", exact: true })
      .getByRole("link", { name, exact: true }),
  ).toBeVisible();
});
