import { z } from "zod";

import { seedRelationshipReviewPrerequisite } from "./e2e-fixtures";
import {
  escapeRegExp,
  expectViewportBounded,
  gotoAuthenticatedPage,
  readExpense,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

export const projectAssignment = z.object({
  projectId: z.string().nullable(),
});

/**
 * The review flow shared by the desktop relationships and graph views.
 */
export function relationshipDiscoveryContract() {
  test("assigned expense offers a reviewed alternative and explores multiple levels", async ({
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
    const showRecords = page.getByRole("button", {
      name: "Show record list",
      exact: true,
    });
    await showRecords.click();
    const records = page.getByLabel("Map records", { exact: true });
    await records
      .getByRole("button", {
        name: new RegExp(`^${escapeRegExp(name)} switch`),
      })
      .click();
    await page
      .getByRole("button", { name: "Expand connections", exact: true })
      .click();
    await expect(
      page.getByRole("complementary", {
        name: "Graph inspector",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", {
        name: `Inspect ${name} supporting expense`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Relationship graph", { exact: true }),
    ).toBeVisible();
    await expectViewportBounded(page);
    await showRecords.click();
    await records
      .getByRole("button", {
        name: new RegExp(`^${escapeRegExp(name)} suggested`),
      })
      .click();
    await expect(
      page.getByRole("link", { name: "Open record", exact: true }),
    ).toHaveAttribute("href", `/projects/${fixture.target.id}`);
  });
}
