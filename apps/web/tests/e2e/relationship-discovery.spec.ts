import { relationshipDiscoveryContract } from "./relationship-discovery-contract";
import {
  seedIngredientPrerequisite,
  seedPlantingPrerequisite,
  seedTaskPrerequisite,
} from "./e2e-fixtures";
import { waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

relationshipDiscoveryContract();

test("a large planting branch shows its first page without an expansion click", async ({
  page,
}) => {
  const suffix = Date.now();
  const task = await seedTaskPrerequisite(page, {
    name: `e2e planting graph ${suffix}`,
  });
  const cropName = `e2e graph crop ${suffix}`;
  const crop = await seedIngredientPrerequisite(page, cropName);
  await Promise.all(
    Array.from({ length: 13 }, () =>
      seedPlantingPrerequisite(page, {
        ingredientId: crop.id,
        taskId: task.id,
      }),
    ),
  );

  await page.goto(`/tasks/${task.id}#relationships`);
  await waitForAppHydration(page);
  await page.getByRole("button", { name: "Graph view", exact: true }).click();

  await expect(page.getByText("12 of 13", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Show record list", exact: true })
    .click();
  await expect(
    page.getByLabel("Map records").getByRole("button", {
      name: new RegExp(`^${cropName}`),
    }),
  ).toHaveCount(12);
});
