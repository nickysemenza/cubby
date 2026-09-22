import { seedNutritionPrerequisite } from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("phone nutrition focuses a nutrient with legible contributions and repair navigation", async ({
  page,
}, testInfo) => {
  const name = `E2E phone nutrition ${Date.now()}-${testInfo.workerIndex}`;
  const { recipe } = await seedNutritionPrerequisite(page, name);
  await gotoAuthenticatedPage(
    page,
    `/recipes/${recipe.id}?view=data&nutritionBasis=serving`,
  );
  const focus = page.getByRole("combobox", { name: "Focused nutrient" });
  const contributions = page.getByTestId("nutrition-contributions");
  // The select is disabled until its boundary hydrates (`useHydrationGate`),
  // so `selectOption` waits out the SSR-to-React handoff on its own.
  await focus.selectOption("protein");
  await expect(contributions).toContainText("5 g–10 g known · partial");
  await expect(
    contributions.getByText(`${name} measured`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Unknown", { exact: true })).toHaveCount(0);
  const bounds = await contributions.boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(402);
  await page.getByRole("button", { name: /^Columns/ }).click();
  const settings = page.getByRole("dialog", { name: "Columns" });
  await expect(settings).toBeVisible();
  await settings
    .getByRole("button", { name: "Actions for Zinc (mg)", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Show Zinc (mg)", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Actions for Zinc (mg)", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Hide Zinc (mg)", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();
  await contributions
    .getByRole("link", { name: `Repair protein data for ${name} incomplete` })
    .click();
  await expect(page).toHaveURL(/\/ingredients\/workbench\?focus=/);
});
