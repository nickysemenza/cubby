import { z } from "zod";

import { seedInheritancePrerequisite } from "./e2e-fixtures";
import {
  expectViewportBounded,
  gotoAuthenticatedPage,
  readExpense,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const assignment = z.object({
  projectId: z.string().nullable(),
  fieldResolutions: z.object({ projectId: z.object({ mode: z.string() }) }),
});

export function inheritanceContract() {
  test("matching project override resets to live purchase inheritance", async ({
    page,
  }) => {
    const fixture = await seedInheritancePrerequisite(
      page,
      `Inheritance ${Date.now()}`,
    );
    const useInherited = page
      .getByRole("button", { name: "Use inherited value", exact: true })
      .first();
    const open = () =>
      gotoAuthenticatedPage(page, `/expenses/${fixture.expense.id}`);
    await open();
    await expect(
      page.getByText("Same as inherited value", { exact: true }).first(),
    ).toBeVisible();
    await useInherited.click();
    await expect
      .poll(() => readExpense(page, fixture.expense.id, assignment))
      .toMatchObject({
        projectId: fixture.project.id,
        fieldResolutions: { projectId: { mode: "inherit" } },
      });
    await expect(
      page.getByText("From purchase", { exact: true }).first(),
    ).toBeVisible();
    await expectViewportBounded(page);
    await gotoAuthenticatedPage(page, `/expenses/${fixture.charge.id}`);
    await expect(
      page.getByText("Allocated from", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.locator(`a[href="/projects/${fixture.project.id}"]`).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "How project is determined", exact: true })
      .click();
    const explanation = page.getByRole("dialog");
    await expect(
      explanation.getByText("Project share", { exact: true }),
    ).toBeVisible();
    await expect(explanation.getByText("$1.00", { exact: true })).toBeVisible();
    // The source link names the project (not its shortcode) once it loads.
    await expect(
      explanation.locator(`a[href="/projects/${fixture.project.id}"]`).first(),
    ).not.toHaveText(fixture.project.id);
    await expect(
      explanation.getByText("Stored override", { exact: true }),
    ).toHaveCount(0);
    await expectViewportBounded(page);
    await gotoAuthenticatedPage(page, `/purchases/${fixture.purchase.id}`);
    const projectCell = page
      .locator('[data-cell-col="project"]')
      .filter({ has: page.getByText("purchase default", { exact: true }) })
      .first();
    await expect(projectCell).toBeVisible();
    await expect
      .poll(() =>
        projectCell.evaluate(
          (cell) => cell.scrollWidth <= cell.clientWidth + 1,
        ),
      )
      .toBe(true);
  });
}
