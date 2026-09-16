import { z } from "zod";

import {
  seedPlacementReviewPrerequisite,
  seedRelationshipReviewPrerequisite,
} from "./e2e-fixtures";
import { expectViewportBounded, waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const projectAssignment = z.object({ projectId: z.string().nullable() });

export function relationshipDiscoveryContract() {
  test("assigned expense offers a reviewed alternative and explores multiple levels on desktop and phone", async ({
    page,
  }) => {
    const name = `e2e relationship review ${Date.now()}`;
    const fixture = await seedRelationshipReviewPrerequisite(page, name);
    await page.goto(`/expenses/${fixture.expense.id}`);
    await waitForAppHydration(page);
    const assignment = async () => {
      const response = await page.request.get(
        `/api/v1/expenses/${fixture.expense.id}`,
      );
      expect(response.ok()).toBe(true);
      return projectAssignment.parse(await response.json()).projectId;
    };
    const alternative = page
      .getByRole("button", { name: `${name} suggested`, exact: true })
      .first();
    await expect(alternative).toBeVisible();
    await alternative.click();
    await expect(
      page.getByRole("button", { name: "Apply change", exact: true }).first(),
    ).toBeVisible();
    expect(await assignment()).toBe(fixture.current.id);
    await page
      .getByRole("button", { name: "Apply change", exact: true })
      .first()
      .click();
    await expect.poll(assignment).toBe(fixture.target.id);

    await page.goto(
      `/entities?tab=explore&entity=expense&root=${fixture.expense.id}`,
    );
    await waitForAppHydration(page);
    await expect(page).toHaveURL((url) => url.pathname === "/graph");
    await page
      .getByRole("button", { name: "Show record list", exact: true })
      .click();
    const records = page.getByLabel("Map records", { exact: true });
    await records
      .getByRole("button", { name: new RegExp(`^${name} switch`) })
      .click();
    await page
      .getByRole("button", { name: "Expand connections", exact: true })
      .click();
    const inspectorHeading = page.getByRole("heading", {
      name: "Graph inspector",
      exact: true,
    });
    if (await inspectorHeading.isVisible()) {
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(inspectorHeading).toBeHidden();
    }
    await expect(
      page.getByRole("group", {
        name: `Inspect ${name} supporting expense`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Relationship graph", { exact: true }),
    ).toBeVisible();
    const hadDesktopInspector = await page
      .getByRole("complementary", { name: "Graph inspector", exact: true })
      .isVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    // The media-query update mounts the selected record's mobile sheet after
    // setViewportSize resolves. Wait for it before deciding whether to close it.
    if (hadDesktopInspector) await expect(inspectorHeading).toBeVisible();
    if (await inspectorHeading.isVisible()) {
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(inspectorHeading).toBeHidden();
    }
    await expectViewportBounded(page);
    await page
      .getByRole("button", { name: "Show record list", exact: true })
      .click();
    await records
      .getByRole("button", { name: new RegExp(`^${name} suggested`) })
      .click();
    await expect(
      page.getByRole("link", { name: "Open record", exact: true }),
    ).toHaveAttribute("href", `/projects/${fixture.target.id}`);
  });
  test("full Relationships review applies an expense alternative", async ({
    page,
  }) => {
    const name = `e2e full relationship ${Date.now()}`;
    const fixture = await seedRelationshipReviewPrerequisite(page, name);
    await page.goto(`/expenses/${fixture.expense.id}`);
    await waitForAppHydration(page);
    await page.getByRole("tab", { name: "Relations", exact: true }).click();
    await page
      .getByRole("button", {
        name: `Review ${name} suggested suggestion`,
        exact: true,
      })
      .click();
    const assignment = async () =>
      projectAssignment.parse(
        await (
          await page.request.get(`/api/v1/expenses/${fixture.expense.id}`)
        ).json(),
      ).projectId;
    expect(await assignment()).toBe(fixture.current.id);
    await page
      .getByRole("button", { name: "Apply change", exact: true })
      .click();
    await expect.poll(assignment).toBe(fixture.target.id);
  });

  test("placement acceptance follows the surviving stock row after merging", async ({
    page,
  }) => {
    const name = `e2e placement ${Date.now()}`;
    const fixture = await seedPlacementReviewPrerequisite(page, name);
    await page.goto(`/inventory/${fixture.source.id}`);
    await waitForAppHydration(page);
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
    await page
      .getByRole("button", { name: "Apply change", exact: true })
      .click();
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
      (
        await page.request.get(`/api/v1/inventory/${fixture.source.id}`)
      ).status(),
    ).toBe(404);
    await expect(
      page.getByText(`${name} workshop`, { exact: true }).first(),
    ).toBeVisible();
  });
}
