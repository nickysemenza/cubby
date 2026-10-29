import { operationCall } from "./support/operation";
import type { Route } from "@playwright/test";

import { browserOperationPath } from "~/lib/browser-operation-path";
import { seedMealNutritionPrerequisite } from "./fixtures/recipes";
import {
  openDetailActions,
  selectComboboxItem,
  gotoAuthenticatedPage,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("meal product nutrition preserves entered amounts on creation", async ({
  page,
}, testInfo) => {
  const name = `Nutrition ${Date.now().toString(36).slice(-5)}-${testInfo.workerIndex}`;
  const fixture = await seedMealNutritionPrerequisite(page, name);
  await gotoAuthenticatedPage(page, `/meals/${fixture.meal.id}`);

  await expect(
    page.getByRole("heading", { name: `${name} meal`, exact: true }),
  ).toBeVisible();
  const guest = page.getByRole("region", {
    name: `${name} guest nutrition`,
  });
  await expect(guest.getByText(fixture.manualFoodName)).toBeVisible();
  await expect(guest.getByLabel(/^Carbs: 0 g\./)).toHaveCount(2);
  await expect(guest.getByLabel(/^Fat: —\./)).toHaveCount(2);

  await openDetailActions(page);
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add food" });
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Person" }),
    `${name} member`,
  );
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Product" }),
    `${name} snack`,
  );
  await dialog.getByLabel("Amount").fill("1 1/2");
  await dialog.getByLabel("Unit").fill("serving");
  await expect(dialog).toContainText("Estimated weight 45 g");
  const firstSaveRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.headers()["x-cubby-operation"] === "meal.saveFood",
  );
  await dialog.getByRole("button", { name: "Add food" }).click();
  const dispatcherUrl = (await firstSaveRequest).url();
  expect(new URL(dispatcherUrl).pathname).toBe(
    browserOperationPath("meal.saveFood"),
  );
  expect(new URL(dispatcherUrl).search).toBe("");
  await expect(dialog).not.toBeVisible();

  const member = page.getByRole("region", {
    name: `${name} member nutrition`,
  });
  const productRow = member.getByRole("listitem").filter({
    has: page.getByText(`${name} snack`, { exact: true }),
  });
  await expect(
    member.getByText(`${name} snack`, { exact: true }),
  ).toBeVisible();
  await expect(productRow.getByText(/servings?/)).toBeVisible();
  await expect(productRow.getByText("Estimated weight 45 g")).toBeVisible();
  await expect(member.getByLabel(/^Calories: 180 kcal\./)).toHaveCount(2);
  await expect(member.getByLabel(/^Protein: 4\.5 g\./)).toHaveCount(2);
  await expect(member.getByLabel(/^Carbs: 30 g\./)).toHaveCount(2);
  await expect(member.getByLabel(/^Fat: 6 g\./)).toHaveCount(2);
});

test("meal product nutrition preserves entered amounts through edits and removal", async ({
  page,
}, testInfo) => {
  const name = `Nutrition edit ${Date.now().toString(36).slice(-5)}-${testInfo.workerIndex}`;
  const fixture = await seedMealNutritionPrerequisite(page, name);
  // Creation through this dialog is covered by the preceding Product food test.
  const seeded = await operationCall(page.request, "meal.saveFood", {
    mealId: fixture.meal.id,
    ledgerPartyId: fixture.member.id,
    sourceKind: "product",
    productId: fixture.product.id,
    amount: { value: 1.5, unit: "serving" },
  });
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  await gotoAuthenticatedPage(page, `/meals/${fixture.meal.id}`);
  const member = page.getByRole("region", { name: `${name} member nutrition` });
  const productRow = member
    .getByRole("listitem")
    .filter({ has: page.getByText(`${name} snack`, { exact: true }) });
  await productRow.getByText("Details and editing", { exact: true }).click();
  await productRow.getByRole("button", { name: "Edit amount" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit food" });
  await expect(editDialog.getByLabel("Amount")).toHaveValue("1 1/2");
  await expect(editDialog.getByLabel("Unit")).toHaveValue("serving");
  await editDialog.getByLabel("Amount").fill("2");
  await editDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(editDialog).not.toBeVisible();
  await expect(productRow.getByText(/2 servings?/)).toBeVisible();
  await expect(member.getByText("Estimated weight 60 g")).toBeVisible();
  await expect(member.getByLabel(/^Calories: 240 kcal\./)).toHaveCount(2);
  await expect(member.getByLabel(/^Protein: 6 g\./)).toHaveCount(2);
  await expect(member.getByLabel(/^Carbs: 40 g\./)).toHaveCount(2);
  await expect(member.getByLabel(/^Fat: 8 g\./)).toHaveCount(2);

  await page.reload();
  await expect(page.getByText("Food updated", { exact: true })).toBeHidden();
  await productRow.getByText("Details and editing", { exact: true }).click();
  await productRow.getByRole("button", { name: "Remove food" }).click();
  await expect(productRow).toHaveCount(0);
});

test("meal ingredient nutrition preserves entered amounts through removal", async ({
  page,
}, testInfo) => {
  const name = `Nutrition ${Date.now().toString(36).slice(-5)}-${testInfo.workerIndex}`;
  const fixture = await seedMealNutritionPrerequisite(page, name);
  await gotoAuthenticatedPage(page, `/meals/${fixture.meal.id}`);
  const member = page.getByRole("region", { name: `${name} member nutrition` });
  await openDetailActions(page);
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  const ingredientDialog = page.getByRole("dialog", { name: "Add food" });
  await ingredientDialog
    .getByRole("button", { name: "Ingredient", exact: true })
    .click();
  await selectComboboxItem(
    page,
    ingredientDialog.getByRole("combobox", { name: "Person" }),
    `${name} member`,
  );
  await selectComboboxItem(
    page,
    ingredientDialog.getByRole("combobox", { name: "Ingredient" }),
    `${name} snack ingredient`,
  );
  await ingredientDialog.getByLabel("Amount").fill("1/2");
  await ingredientDialog.getByLabel("Unit").fill("serving");
  await expect(ingredientDialog).toContainText("Estimated weight 15 g");
  await ingredientDialog.getByRole("button", { name: "Add food" }).click();
  await expect(ingredientDialog).not.toBeVisible();
  const ingredientRow = member
    .getByRole("listitem")
    .filter({ hasText: `${name} snack ingredient` });
  await expect(ingredientRow.getByText(/serving/)).toBeVisible();
  await expect(ingredientRow.getByText("Estimated weight 15 g")).toBeVisible();

  await page.reload();
  const refreshedIngredientRow = page
    .getByRole("region", { name: `${name} member nutrition` })
    .getByRole("listitem")
    .filter({ hasText: `${name} snack ingredient` });
  await refreshedIngredientRow
    .getByText("Details and editing", { exact: true })
    .click();
  await refreshedIngredientRow
    .getByRole("button", { name: "Remove food" })
    .click();
  await expect(
    page.getByRole("region", { name: `${name} member nutrition` }),
  ).toHaveCount(0);
});

test("meal nutrition links planned days and today from home", async ({
  page,
}, testInfo) => {
  const name = `Nutrition ${Date.now().toString(36).slice(-5)}-${testInfo.workerIndex}`;
  const fixture = await seedMealNutritionPrerequisite(page, name, {
    seedProductPortion: true,
  });
  await gotoAuthenticatedPage(
    page,
    `/meals?view=nutrition&date=${fixture.futureDate}`,
  );
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/meals" &&
      url.searchParams.get("view") === "nutrition" &&
      url.searchParams.get("date") === fixture.futureDate,
  );
  await expect(page.getByText("Planned", { exact: true })).toBeVisible();

  await gotoAuthenticatedPage(page, "/");
  const homeSummary = page.getByRole("region", {
    name: "Today's nutrition",
  });
  await expect(homeSummary.getByText(`${name} member`)).toBeVisible();
  await homeSummary.getByRole("link", { name: "View day" }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/meals" &&
      url.searchParams.get("view") === "nutrition" &&
      url.searchParams.get("date") === fixture.today,
  );
});

test("daily nutrition keeps manual food input after a failed save and retries it", async ({
  page,
  e2eRuntime,
}, testInfo) => {
  const name = `Nutrition ${Date.now().toString(36).slice(-5)}-${testInfo.workerIndex}`;
  const fixture = await seedMealNutritionPrerequisite(page, name);
  const dispatcherUrl = new URL(
    browserOperationPath("meal.saveFood"),
    e2eRuntime.baseURL,
  ).href;
  await gotoAuthenticatedPage(
    page,
    `/meals?view=nutrition&date=${fixture.inlineDate}`,
  );
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  const targetDialog = page.getByRole("dialog", {
    name: "Add food to a meal",
  });
  await targetDialog.getByRole("button", { name: "New meal or snack" }).click();
  await expect(
    targetDialog.getByRole("combobox", { name: "Occasion" }),
  ).toHaveText(/Snack/);
  await targetDialog.getByLabel("Name (optional)").fill(`${name} snack break`);
  await targetDialog.getByRole("button", { name: "Continue to food" }).click();

  const dailyFoodDialog = page.getByRole("dialog", { name: "Add food" });
  await expect(dailyFoodDialog).toBeVisible();
  await dailyFoodDialog.getByRole("button", { name: "Manual" }).click();
  await selectComboboxItem(
    page,
    dailyFoodDialog.getByRole("combobox", { name: "Person" }),
    `${name} member`,
  );
  const dailyFoodName = `${name} trail snack`;
  await dailyFoodDialog.getByLabel("Food name").fill(dailyFoodName);
  await dailyFoodDialog.getByLabel("Calories (kcal)").fill("90");
  await dailyFoodDialog.getByLabel("Protein (g)").fill("7");
  await dailyFoodDialog.getByLabel("Carbs (g)").fill("0");
  await dailyFoodDialog.getByLabel(/Serving amount/).fill("1/2");
  await dailyFoodDialog.getByLabel("Unit").fill("bowl");
  await expect(dailyFoodDialog).toContainText(
    "Current conversion unavailable; this amount can still be saved.",
  );

  let failedSave = false;
  const failFirstManualSave = async (route: Route) => {
    if (
      !failedSave &&
      route.request().headers()["x-cubby-operation"] === "meal.saveFood"
    ) {
      failedSave = true;
      await route.abort("failed");
      return;
    }
    await route.fallback();
  };
  await page.route(dispatcherUrl, failFirstManualSave);
  await dailyFoodDialog.getByRole("button", { name: "Add food" }).click();
  await expect(dailyFoodDialog.getByRole("alert")).toBeVisible();
  expect(failedSave).toBe(true);
  await expect(dailyFoodDialog.getByLabel("Food name")).toHaveValue(
    dailyFoodName,
  );
  await expect(dailyFoodDialog.getByLabel("Calories (kcal)")).toHaveValue("90");
  await expect(dailyFoodDialog.getByLabel("Protein (g)")).toHaveValue("7");
  await expect(dailyFoodDialog.getByLabel("Carbs (g)")).toHaveValue("0");
  await expect(dailyFoodDialog.getByLabel(/Serving amount/)).toHaveValue("1/2");
  await expect(dailyFoodDialog.getByLabel("Unit")).toHaveValue("bowl");

  const successfulRetry = page.waitForResponse(
    (response) =>
      response.ok() &&
      response.request().headers()["x-cubby-operation"] === "meal.saveFood",
  );
  await dailyFoodDialog.getByRole("button", { name: "Add food" }).click();
  await successfulRetry;
  await page.unroute(dispatcherUrl, failFirstManualSave);
  await expect(dailyFoodDialog).not.toBeVisible();

  const inlineSummary = page.getByRole("region", {
    name: `${name} member nutrition`,
  });
  await expect(inlineSummary.getByText(dailyFoodName)).toBeVisible();
  await expect(inlineSummary.getByText(/bowl/)).toBeVisible();
  await expect(
    inlineSummary.getByText(/Current conversion unavailable/),
  ).toBeVisible();
  await expect(inlineSummary.getByLabel(/^Calories: 90 kcal\./)).toHaveCount(3);
  await expect(inlineSummary.getByLabel(/^Protein: 7 g\./)).toHaveCount(3);
  await expect(inlineSummary.getByLabel(/^Carbs: 0 g\./)).toHaveCount(3);
  await expect(inlineSummary.getByLabel(/^Fat: —\./)).toHaveCount(3);
  await expect(
    page.getByText(`${name} snack break`, { exact: true }),
  ).toBeVisible();
});
