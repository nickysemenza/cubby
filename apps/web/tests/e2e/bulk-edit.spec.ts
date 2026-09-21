import {
  seedIngredientPrerequisite,
  seedPlantingPrerequisite,
  seedTaskPrerequisite,
} from "./e2e-fixtures";
import { waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

/**
 * The generic `bulkEdit` action (`bulk-edit-entity-action.tsx`): a list's
 * multi-select bar opens one dialog driven by `capabilities.bulkUpdate.fields`,
 * and the write touches only the fields the dialog's form was dirtied on —
 * every unselected task/planting keeps its other seeded values.
 */

test("task board multi-select bulk-edits status without touching other fields", async ({
  page,
}) => {
  const suffix = Date.now();
  const taskOneName = `e2e bulk task one ${suffix}`;
  const taskTwoName = `e2e bulk task two ${suffix}`;
  const taskOne = await seedTaskPrerequisite(page, { name: taskOneName });
  const taskTwo = await seedTaskPrerequisite(page, { name: taskTwoName });

  await page.goto("/tasks");
  await waitForAppHydration(page);

  for (const name of [taskOneName, taskTwoName]) {
    const row = page.getByRole("row").filter({ hasText: name });
    await row.getByRole("checkbox", { name: "Select row" }).click();
  }

  await page
    .locator("[data-bulk-action-bar]")
    .getByRole("button", { name: "Bulk edit...", exact: true })
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Bulk edit 2 Tasks?")).toBeVisible();

  await dialog.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "Done", exact: true }).click();

  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  for (const task of [taskOne, taskTwo]) {
    const updated = await page.request.get(`/api/v1/tasks/${task.id}`);
    expect(await updated.json()).toMatchObject({
      status: "done",
      // Seeded as "other" and never touched in the dialog — proves the
      // write was the dirty-field subset, not the whole form.
      trade: "other",
    });
  }
});

test("plantings list bulk-edits status finished plus a date in one write", async ({
  page,
}) => {
  const suffix = Date.now();
  const cropName = `e2e bulk crop ${suffix}`;
  const otherCropName = `e2e unrelated crop ${suffix}`;
  const crop = await seedIngredientPrerequisite(page, cropName);
  const otherCrop = await seedIngredientPrerequisite(page, otherCropName);
  const planting = await seedPlantingPrerequisite(page, {
    ingredientId: crop.id,
  });
  await seedPlantingPrerequisite(page, { ingredientId: otherCrop.id });

  await page.goto(`/plantings?ingredientId=${crop.id}`);
  await waitForAppHydration(page);

  await expect(
    page.getByRole("button", { name: `Crop: ${cropName}`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: otherCropName }),
  ).toHaveCount(0);

  await page
    .getByRole("row")
    .filter({ hasText: cropName })
    .getByRole("checkbox", { name: "Select row" })
    .click();

  await page
    .locator("[data-bulk-action-bar]")
    .getByRole("button", { name: "Bulk edit...", exact: true })
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Bulk edit 1 Planting?")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Update", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByText(/cannot proceed/iu)).toHaveCount(0);

  await dialog.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "Finished", exact: true }).click();
  await dialog.getByLabel("Finished", { exact: true }).fill("2026-06-01");

  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  const updated = await page.request.get(`/api/v1/plantings/${planting.id}`);
  expect(await updated.json()).toMatchObject({
    status: "finished",
    finishedOn: "2026-06-01",
  });
});
