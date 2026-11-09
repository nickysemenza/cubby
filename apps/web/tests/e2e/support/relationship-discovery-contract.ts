import { seedRelationshipReviewPrerequisite } from "../fixtures/finance";
import {
  escapeRegExp,
  expectViewportBounded,
  gotoAuthenticatedPage,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

/**
 * The review flow shared by the desktop relationships and graph views.
 */
export function relationshipDiscoveryContract() {
  test("assigned expense explores multiple levels", async ({ page }) => {
    const name = `e2e relationship review ${Date.now()}`;
    const fixture = await seedRelationshipReviewPrerequisite(page, name);
    await gotoAuthenticatedPage(page, `/expenses/${fixture.expense.id}`);

    await gotoAuthenticatedPage(
      page,
      `/entities?tab=explore&entity=expense&root=${fixture.expense.id}`,
    );
    await expect(page).toHaveURL((url) => url.pathname === "/graph");
    const showRecords = page.getByRole("button", {
      name: "Paths list",
      exact: true,
    });
    await showRecords.click();
    const records = page.getByLabel("Map records", { exact: true });
    await records
      .getByRole("button", {
        name: new RegExp(`^Inspect ${escapeRegExp(name)} switch`),
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
      page.getByLabel("Relationship graph", { exact: true }),
    ).toBeVisible();
    await expectViewportBounded(page);
    await showRecords.click();
    await expect(
      records.getByRole("button", {
        name: new RegExp(`^Inspect ${escapeRegExp(name)} supporting expense`),
      }),
    ).toBeVisible();
    await records
      .getByRole("button", {
        name: new RegExp(`^Inspect ${escapeRegExp(name)} suggested`),
      })
      .click();
    await expect(
      page.getByRole("link", { name: "Open record", exact: true }),
    ).toHaveAttribute("href", `/projects/${fixture.target.id}`);
  });
}
