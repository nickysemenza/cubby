import type { Page } from "@playwright/test";

import { gotoAuthenticatedPage, reloadAuthenticatedPage } from "./e2e-helpers";
import { seedStaplePlanningPrerequisite } from "./e2e-fixtures";
import { expect, test } from "./e2e-test";

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

test("usually-on-hand marking persists and changes planning without inventory", async ({
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
  await expect(staples.getByText(/^10\s*g$/)).toBeVisible();
  await expect(staples.getByRole("checkbox")).toHaveCount(0);
  await reloadAuthenticatedPage(page);
  await expect(staples.getByRole("link", { name, exact: true })).toBeVisible();
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
