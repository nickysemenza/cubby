import { seedStaplePlanningPrerequisite } from "./e2e-fixtures";
import { escapeRegExp, gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// `seedStaplePlanningPrerequisite` plans "<name> meal" on 2026-09-09, so the
// week of 2026-09-16 is the following one.
const NEXT_WEEK = "/meals?view=calendar&period=week&week=2026-09-16";

test("copy last week plans the previous week's meals into the week shown", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Meal copy");
  await seedStaplePlanningPrerequisite(page, name);
  const mealChip = page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(name)} meal`),
  });

  await gotoAuthenticatedPage(page, NEXT_WEEK);
  await expect(mealChip).toHaveCount(0);
  await page.getByRole("button", { name: "Copy last week" }).click();
  // Other specs in this worker's database plan meals on the same fixture
  // date, so the copied total varies; this spec's own chip is the assertion.
  await expect(
    page.getByText(/^Copied \d+ meals? from last week$/),
  ).toBeVisible();
  await expect(mealChip).toHaveCount(1);

  // Copies append rather than replace: a second copy adds a second plan.
  await page.getByRole("button", { name: "Copy last week" }).click();
  await expect(mealChip).toHaveCount(2);
});

test("a meal is duplicated from its calendar inspector", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Meal duplicate");
  await seedStaplePlanningPrerequisite(page, name);
  const mealChip = page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(name)} meal`),
  });

  await gotoAuthenticatedPage(
    page,
    "/meals?view=calendar&period=week&week=2026-09-09",
  );
  await mealChip.click();
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page.getByText("Meal duplicated")).toBeVisible();
  await expect(mealChip).toHaveCount(2);
});
