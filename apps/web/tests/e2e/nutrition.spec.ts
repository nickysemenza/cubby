import {
  clearNutritionCachePrerequisite,
  seedNutritionPrerequisite,
} from "./e2e-fixtures";
import { waitForAppHydration, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("nutrition matrix shares URL basis, preserves partial ranges and zero, and exposes the catalog", async ({
  page,
}, testInfo) => {
  const name = `E2E nutrition ${Date.now()}-${testInfo.workerIndex}`;
  const { recipe, incomplete } = await seedNutritionPrerequisite(page, name);
  await gotoAuthenticatedPage(page, `/recipes/${recipe.id}?view=data`);
  const contributions = page.getByTestId("nutrition-contributions");
  const focus = page.getByRole("combobox", { name: "Focused nutrient" });
  const table = page.getByRole("table", { name: "Recipe Ingredients Table" });
  await expect(contributions).toContainText("150 kcal–250 kcal");
  await expect(
    table.getByRole("columnheader", { name: /Calcium/ }),
  ).toHaveCount(0);
  await focus.selectOption("protein");
  await expect(contributions).toContainText("10 g–20 g known · partial");
  await expect(
    contributions.getByRole("link", {
      name: `Repair protein data for ${name} incomplete`,
    }),
  ).toHaveAttribute(
    "href",
    new RegExp(`/ingredients/workbench\\?focus=${incomplete.id}`),
  );
  await page.getByRole("button", { name: "Per serving", exact: true }).click();
  await expect(page).toHaveURL(/nutritionBasis=serving/);
  await expect(contributions).toContainText("5 g–10 g known · partial");
  await page.reload();
  await waitForAppHydration(page);
  await expect(
    page.getByRole("button", { name: "Per serving", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(contributions).toContainText("75 kcal–125 kcal");
  await focus.selectOption("sodium");
  await expect(contributions).toContainText("0 mg known · partial");
  await focus.selectOption("calcium");
  await expect(
    table.getByRole("columnheader", { name: /Calcium/ }),
  ).toBeVisible();
  await expect(contributions).toContainText("25 mg–50 mg known · partial");
  await page.getByRole("button", { name: /^Columns/ }).click();
  await expect(
    page.getByRole("button", { name: "Show Zinc (mg)", exact: true }),
  )
    .toBeVisible()
    .catch(async (error) => {
      // Failure path only: a route error hides its real message behind
      // "Technical details"; open it if present and report the page text
      // instead of a bare missing-button timeout.
      await page
        .getByRole("button", { name: "Technical details", exact: true })
        .click({ timeout: 2000 })
        .catch(() => undefined);
      throw new Error(await page.getByRole("main").innerText(), {
        cause: error,
      });
    });
  await page
    .getByRole("button", { name: "Show Zinc (mg)", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(table.getByRole("columnheader", { name: /Zinc/ })).toBeVisible();
  await gotoAuthenticatedPage(page, `/recipes/${recipe.id}?view=data&scale=2`);
  await expect(contributions).toContainText("300 kcal–500 kcal");
  await page.getByRole("button", { name: "Per serving", exact: true }).click();
  await expect(contributions).toContainText("75 kcal–125 kcal");
  await gotoAuthenticatedPage(
    page,
    `/recipes/${recipe.id}?view=data&scale=0.3333&nutritionBasis=serving`,
  );
  await expect(contributions).toContainText("75 kcal–125 kcal");
});

test("calendar discloses partial planned nutrition and pending cleared totals", async ({
  page,
}, testInfo) => {
  const name = `E2E calendar nutrition ${Date.now()}-${testInfo.workerIndex}`;
  const { recipe } = await seedNutritionPrerequisite(page, name, {
    missingCalories: true,
  });
  await gotoAuthenticatedPage(page, "/calendar?period=week&date=2026-09-09");
  const event = page.getByRole("button", {
    name: `${name} meal, All day`,
    exact: true,
  });
  await expect(event).toBeVisible();
  await expect(event).toContainText("100 kcal–200 kcal known · partial");
  await clearNutritionCachePrerequisite(recipe.id);
  await page.reload();
  await waitForAppHydration(page);
  await expect(event).toContainText("Pending");
});
