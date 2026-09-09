import type { Page } from "@playwright/test";

import { seedStaplePlanningPrerequisite } from "./e2e-fixtures";
import { expect, test } from "./e2e-test";

async function openIngredientEditor(page: Page) {
  const checkbox = page.getByRole("checkbox", {
    name: "Usually on hand",
    exact: true,
  });
  // A server-rendered detail page can accept a pointer event just before its
  // edit handler hydrates. Retry the actual user action until the editor is
  // present instead of treating that harmless no-op as a product failure.
  await expect(async () => {
    await page
      .getByRole("button", { name: "Edit Ingredient", exact: true })
      .click();
    await expect(checkbox).toBeVisible();
  }).toPass();
  return checkbox;
}

test("usually-on-hand marking persists and changes planning without inventory", async ({
  page,
}) => {
  const name = `Staple ${Date.now()}`;
  const { ingredient, recipe } = await seedStaplePlanningPrerequisite(
    page,
    name,
  );
  await page.goto(`/ingredients/${ingredient.id}`);
  const checkbox = await openIngredientEditor(page);
  await checkbox.check();
  await page.getByRole("button", { name: /Save/ }).click();
  await expect(
    page.getByRole("checkbox", { name: "Usually on hand", exact: true }),
  ).toHaveCount(0);
  await page.goto(`/recipes/${recipe.id}`);
  await expect(page.getByText(/^Staples assumed/)).toBeVisible();
  await page.goto("/meals/shopping-list?from=2026-09-09&to=2026-09-09");
  const staples = page.getByRole("region", {
    name: "Usually on hand",
    exact: true,
  });
  await expect(staples.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(staples.getByRole("checkbox")).toHaveCount(0);
  await page.reload();
  await expect(staples.getByRole("link", { name, exact: true })).toBeVisible();
  await page.goto(`/ingredients/${ingredient.id}`);
  const checkedCheckbox = await openIngredientEditor(page);
  await expect(checkedCheckbox).toBeChecked();
  await checkedCheckbox.uncheck();
  await page.getByRole("button", { name: /Save/ }).click();
  await expect(
    page.getByRole("checkbox", { name: "Usually on hand", exact: true }),
  ).toHaveCount(0);
  await page.goto("/meals/shopping-list?from=2026-09-09&to=2026-09-09");
  await expect(
    page
      .getByRole("region", { name: "To buy", exact: true })
      .getByRole("link", { name, exact: true }),
  ).toBeVisible();
});
