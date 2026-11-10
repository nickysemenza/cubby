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

test("usually-on-hand marking affects planning and the shopping list", async ({
  page,
}) => {
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
    staples
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name, exact: true }) })
      .locator('[data-cell-col="need"]'),
  ).toHaveText(/^10\s*g$/);
  await expect(staples.getByRole("checkbox")).toHaveCount(0);
  await reloadAuthenticatedPage(page);
  await expect(staples.getByRole("link", { name, exact: true })).toBeVisible();

  await gotoAuthenticatedPage(page, `/ingredients/${ingredient.id}`);
  const checkboxToUnmark = await openIngredientEditor(page);
  await expect(checkboxToUnmark).toBeChecked();
  await checkboxToUnmark.uncheck();
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
