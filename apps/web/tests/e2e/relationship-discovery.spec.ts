import { relationshipDiscoveryContract } from "./support/relationship-discovery-contract";
import {
  seedPlantPrerequisite,
  seedTaskPrerequisite,
} from "./fixtures/catalog";
import { createEntityFixtures } from "./fixtures/core";
import { escapeRegExp, gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

relationshipDiscoveryContract();

test("a large planting branch stays collapsed until requested", async ({
  page,
}) => {
  const suffix = Date.now();
  const task = await seedTaskPrerequisite(page, {
    name: `e2e planting graph ${suffix}`,
  });
  const cropName = `e2e graph crop ${suffix}`;
  const crop = await seedPlantPrerequisite(page, cropName);
  await createEntityFixtures(
    page,
    "planting",
    Array.from({ length: 13 }, () => ({
      plantId: crop.id,
      taskId: task.id,
      locationId: null,
    })),
  );

  await gotoAuthenticatedPage(page, `/tasks/${task.id}#relationships`);

  await page
    .getByRole("button", { name: "Expand Plantings (13)", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Collapse Plantings (13)", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Paths list", exact: true }).click();
  await expect(
    page.getByLabel("Map records").getByRole("button", {
      name: new RegExp(`^Inspect ${escapeRegExp(cropName)}.* Planting$`),
    }),
  ).toHaveCount(12);
});
