import { seedMealNutritionPrerequisite } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("phone meal nutrition stacks people and keeps the food form in bounds", async ({
  page,
}, testInfo) => {
  const name = `Phone ${Date.now().toString(36).slice(-5)}-${testInfo.workerIndex}`;
  const fixture = await seedMealNutritionPrerequisite(page, name, {
    seedProductPortion: true,
  });
  await gotoAuthenticatedPage(page, `/meals/${fixture.meal.id}`);

  await expect(
    page.getByRole("region", { name: `${name} member nutrition` }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: `${name} guest nutrition` }),
  ).toBeVisible();
  await expectViewportBounded(page);

  await page.getByRole("button", { name: "Add food", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add food" });
  await expect(dialog).toHaveAttribute("data-side", "bottom");
  await dialog.getByRole("button", { name: "Manual" }).click();
  await expect(dialog.getByLabel("Food name")).toBeVisible();
  await expect(dialog.getByLabel("Calories (kcal)")).toBeVisible();
  await expect(dialog.getByLabel(/Serving amount/)).toBeVisible();
  await expect(dialog.getByLabel("Unit")).toHaveValue("g");
  await expectViewportBounded(page);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  await gotoAuthenticatedPage(
    page,
    `/meals?view=nutrition&date=${fixture.today}`,
  );
  await expect(
    page.getByRole("region", { name: `${name} member nutrition` }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: `${name} guest nutrition` }),
  ).toBeVisible();
  await expectViewportBounded(page);
});
