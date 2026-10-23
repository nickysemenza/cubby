import { z } from "zod";

import { seedInheritancePrerequisite } from "../fixtures/finance";
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
      .getByRole("button", { name: "Use inherited", exact: true })
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
  });
}
