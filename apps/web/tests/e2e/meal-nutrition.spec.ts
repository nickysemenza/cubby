import type { Route } from "@playwright/test";

import { seedMealNutritionPrerequisite } from "./e2e-fixtures";
import { selectComboboxItem, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("meal nutrition keeps entered product and ingredient amounts while deriving current estimates", async ({
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
  await expect(guest.getByLabel(/^Fat: — g\./)).toHaveCount(2);

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
  expect(new URL(dispatcherUrl).pathname).toBe("/_serverFn/dispatch");
  expect(new URL(dispatcherUrl).searchParams.get("operation")).toBe(
    "meal.saveFood",
  );
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

  const productDetails = productRow.locator("details").first();
  if ((await productDetails.getAttribute("open")) !== null) {
    await productRow.getByText("Details and editing", { exact: true }).click();
  }
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await expect(page.getByText("Food updated", { exact: true })).toBeHidden({
    timeout: 5000,
  });
});

test("meal nutrition connects planned and today views and removes food portions", async ({
  page,
}, testInfo) => {
  const name = `Nutrition ${Date.now().toString(36).slice(-5)}-${testInfo.workerIndex}`;
  const fixture = await seedMealNutritionPrerequisite(page, name, {
    seedProductPortion: true,
    seedIngredientPortion: true,
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

  await gotoAuthenticatedPage(page, `/meals/${fixture.meal.id}`);
  const refreshedProductRow = page
    .getByRole("region", { name: `${name} member nutrition` })
    .getByRole("listitem")
    .filter({
      has: page.getByText(`${name} snack`, { exact: true }),
    });
  await refreshedProductRow
    .getByText("Details and editing", { exact: true })
    .click();
  await refreshedProductRow
    .getByRole("button", { name: "Remove food" })
    .click();
  await expect(
    page.getByText(`${name} snack`, { exact: true }),
  ).not.toBeVisible();
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

test("manual nutrition food keeps inputs across failed save and retry", async ({
  page,
}, testInfo) => {
  const name = `Nutrition ${Date.now().toString(36).slice(-5)}-${testInfo.workerIndex}`;
  const fixture = await seedMealNutritionPrerequisite(page, name);

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
  ).toHaveValue("Snack");
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

  const dispatcherUrl = "**/_serverFn/dispatch**";
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
  await expect(inlineSummary.getByLabel(/^Fat: — g\./)).toHaveCount(3);
  await expect(
    page.getByText(`${name} snack break`, { exact: true }),
  ).toBeVisible();
});
