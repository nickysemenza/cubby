import { z } from "zod";

import {
  projectAssignment,
  relationshipDiscoveryContract,
} from "./relationship-discovery-contract";
import {
  seedPlantPrerequisite,
  seedPlacementReviewPrerequisite,
  seedPlantingPrerequisite,
  seedRelationshipReviewPrerequisite,
  seedTaskPrerequisite,
} from "./e2e-fixtures";
import {
  escapeRegExp,
  gotoAuthenticatedPage,
  readExpense,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

relationshipDiscoveryContract();

test("full Relationships review applies an expense alternative", async ({
  page,
}) => {
  const name = `e2e full relationship ${Date.now()}`;
  const fixture = await seedRelationshipReviewPrerequisite(page, name);
  await gotoAuthenticatedPage(page, `/expenses/${fixture.expense.id}`);
  await page.getByRole("tab", { name: "Relations", exact: true }).click();
  await page
    .getByRole("button", {
      name: `Review ${name} suggested suggestion`,
      exact: true,
    })
    .click();
  const assignment = async () =>
    (await readExpense(page, fixture.expense.id, projectAssignment)).projectId;
  expect(await assignment()).toBe(fixture.current.id);
  await page.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect.poll(assignment).toBe(fixture.target.id);
});

test("placement acceptance follows the surviving stock row after merging", async ({
  page,
}) => {
  const name = `e2e placement ${Date.now()}`;
  const fixture = await seedPlacementReviewPrerequisite(page, name);
  await gotoAuthenticatedPage(page, `/inventory/${fixture.source.id}`);
  await page.getByRole("tab", { name: "Relations", exact: true }).click();
  await page
    .getByRole("button", {
      name: `Review ${name} workshop suggestion`,
      exact: true,
    })
    .click();
  expect(
    (await page.request.get(`/api/v1/inventory/${fixture.source.id}`)).ok(),
  ).toBe(true);
  await page.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(fixture.destination.id));
  const survivor = z.object({
    location: z.object({ id: z.string() }),
    amount: z.object({ value: z.number() }),
  });
  await expect
    .poll(
      async () =>
        survivor.parse(
          await (
            await page.request.get(
              `/api/v1/inventory/${fixture.destination.id}`,
            )
          ).json(),
        ).amount.value,
    )
    .toBe(2);
  expect(
    survivor.parse(
      await (
        await page.request.get(`/api/v1/inventory/${fixture.destination.id}`)
      ).json(),
    ).location.id,
  ).toBe(fixture.target.id);
  expect(
    (await page.request.get(`/api/v1/inventory/${fixture.source.id}`)).status(),
  ).toBe(404);
  await expect(
    page.getByText(`${name} workshop`, { exact: true }).first(),
  ).toBeVisible();
});

test("a large planting branch shows its first page without an expansion click", async ({
  page,
}) => {
  const suffix = Date.now();
  const task = await seedTaskPrerequisite(page, {
    name: `e2e planting graph ${suffix}`,
  });
  const cropName = `e2e graph crop ${suffix}`;
  const crop = await seedPlantPrerequisite(page, cropName);
  await Promise.all(
    Array.from({ length: 13 }, () =>
      seedPlantingPrerequisite(page, {
        plantId: crop.id,
        taskId: task.id,
      }),
    ),
  );

  await gotoAuthenticatedPage(page, `/tasks/${task.id}#relationships`);
  await page.getByRole("button", { name: "Graph view", exact: true }).click();

  await expect(page.getByText("12 of 13", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Show record list", exact: true })
    .click();
  await expect(
    page.getByLabel("Map records").getByRole("button", {
      name: new RegExp(`^${escapeRegExp(cropName)}`),
    }),
  ).toHaveCount(12);
});
