import { z } from "zod";

import {
  seedPlacementReviewPrerequisite,
  seedRelationshipReviewPrerequisite,
} from "./e2e-fixtures";
import {
  escapeRegExp,
  expectViewportBounded,
  gotoAuthenticatedPage,
  readExpense,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const projectAssignment = z.object({ projectId: z.string().nullable() });

export function relationshipDiscoveryContract() {
  test("assigned expense offers a reviewed alternative and explores multiple levels on desktop and phone", async ({
    page,
  }) => {
    const name = `e2e relationship review ${Date.now()}`;
    const fixture = await seedRelationshipReviewPrerequisite(page, name);
    await gotoAuthenticatedPage(page, `/expenses/${fixture.expense.id}`);
    const assignment = async () =>
      (await readExpense(page, fixture.expense.id, projectAssignment))
        .projectId;
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

    await gotoAuthenticatedPage(
      page,
      `/entities?tab=explore&entity=expense&root=${fixture.expense.id}`,
    );
    await expect(page).toHaveURL((url) => url.pathname === "/graph");
    await page
      .getByRole("button", { name: "Show record list", exact: true })
      .click();
    const records = page.getByLabel("Map records", { exact: true });
    await records
      .getByRole("button", {
        name: new RegExp(`^${escapeRegExp(name)} switch`),
      })
      .click();
    await page
      .getByRole("button", { name: "Expand connections", exact: true })
      .click();
    // Below md the inspector is a bottom sheet (titled "Graph inspector") that
    // selecting a record opens; at desktop width it is a permanent aside.
    const inspectorHeading = page.getByRole("heading", {
      name: "Graph inspector",
      exact: true,
    });
    const inspectorAside = page.getByRole("complementary", {
      name: "Graph inspector",
      exact: true,
    });
    const closeInspectorSheet = async () => {
      await expect(inspectorHeading).toBeVisible();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(inspectorHeading).toBeHidden();
    };
    const startedOnPhone = (page.viewportSize()?.width ?? 0) < 768;
    if (startedOnPhone) await closeInspectorSheet();
    else await expect(inspectorAside).toBeVisible();
    await expect(
      page.getByRole("group", {
        name: `Inspect ${name} supporting expense`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Relationship graph", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    // Crossing below md mounts the selected record's sheet (after
    // setViewportSize resolves); a phone already closed its sheet above.
    if (startedOnPhone) await expect(inspectorHeading).toBeHidden();
    else await closeInspectorSheet();
    await expectViewportBounded(page);
    await page
      .getByRole("button", { name: "Show record list", exact: true })
      .click();
    await records
      .getByRole("button", {
        name: new RegExp(`^${escapeRegExp(name)} suggested`),
      })
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
    await gotoAuthenticatedPage(page, `/expenses/${fixture.expense.id}`);
    await page.getByRole("tab", { name: "Relations", exact: true }).click();
    await page
      .getByRole("button", {
        name: `Review ${name} suggested suggestion`,
        exact: true,
      })
      .click();
    const assignment = async () =>
      (await readExpense(page, fixture.expense.id, projectAssignment))
        .projectId;
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
