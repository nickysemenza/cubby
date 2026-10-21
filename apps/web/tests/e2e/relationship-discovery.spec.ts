import { entityApi } from "./support/entity-api";
import { z } from "zod";

import { relationshipDiscoveryContract } from "./support/relationship-discovery-contract";
import {
  seedPlantPrerequisite,
  seedPlacementReviewPrerequisite,
  seedTaskPrerequisite,
} from "./fixtures/catalog";
import { createEntityFixtures } from "./fixtures/core";
import { escapeRegExp, gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

relationshipDiscoveryContract();

test("placement acceptance follows the surviving stock row after merging", async ({
  page,
}) => {
  const name = `e2e placement ${Date.now()}`;
  const fixture = await seedPlacementReviewPrerequisite(page, name);
  await gotoAuthenticatedPage(page, `/inventory/${fixture.source.id}`);
  const proposals = page.getByRole("region", {
    name: "Pending suggestions",
    exact: true,
  });
  await expect(proposals).toContainText(`${name} workshop`);
  expect(
    (
      await entityApi(page.request).get("inventory", fixture.source.id, {})
    ).ok(),
  ).toBe(true);
  await proposals.getByRole("button", { name: "Confirm", exact: true }).click();
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
            await entityApi(page.request).get(
              "inventory",
              fixture.destination.id,
              {},
            )
          ).json(),
        ).amount.value,
    )
    .toBe(2);
  expect(
    survivor.parse(
      await (
        await entityApi(page.request).get(
          "inventory",
          fixture.destination.id,
          {},
        )
      ).json(),
    ).location.id,
  ).toBe(fixture.target.id);
  expect(
    (
      await entityApi(page.request).get("inventory", fixture.source.id, {})
    ).status(),
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
