import { seedMealNutritionPrerequisite } from "./e2e-fixtures";
import { expectViewportBounded, waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test.setTimeout(45_000);

test("phone meal nutrition stacks people and keeps the food form in bounds", async ({
  page,
}, testInfo) => {
  const name = `Phone ${Date.now().toString(36).slice(-5)}-${testInfo.workerIndex}`;
  const fixture = await seedMealNutritionPrerequisite(page, name, {
    seedProductPortion: true,
  });
  await page.goto(`/meals/${fixture.meal.id}`);
  await waitForAppHydration(page);

  await expect(
    page.getByRole("region", { name: `${name} member nutrition` }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: `${name} guest nutrition` }),
  ).toBeVisible();
  await expectViewportBounded(page);
  await page.screenshot({
    path: testInfo.outputPath("meal-nutrition-phone-overview.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Add food", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add food" });
  await expect(dialog).toHaveAttribute("data-side", "bottom");
  await dialog.getByRole("button", { name: "Manual" }).click();
  await expect(dialog.getByLabel("Food name")).toBeVisible();
  await expect(dialog.getByLabel("Calories (kcal)")).toBeVisible();
  await expect(dialog.getByLabel("Weight (g, optional)")).toBeVisible();
  await expectViewportBounded(page);

  await page.screenshot({
    path: testInfo.outputPath("meal-nutrition-phone-form.png"),
    fullPage: false,
  });

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  await page.goto(`/meals?view=nutrition&date=${fixture.today}`);
  await waitForAppHydration(page);
  await expect(
    page.getByRole("region", { name: `${name} member nutrition` }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: `${name} guest nutrition` }),
  ).toBeVisible();
  await expectViewportBounded(page);
  await page.screenshot({
    path: testInfo.outputPath("meal-nutrition-daily-phone.png"),
    fullPage: true,
  });
});
