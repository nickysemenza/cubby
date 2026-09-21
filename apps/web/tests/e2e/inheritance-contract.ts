import { z } from "zod";

import { seedInheritancePrerequisite } from "./e2e-fixtures";
import { expectViewportBounded, waitForAppHydration } from "./e2e-helpers";
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
    await page.goto(`/expenses/${fixture.expense.id}`);
    await waitForAppHydration(page);
    await expect(
      page.getByText("Matches inherited value", { exact: true }).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Use inherited value", exact: true })
      .first()
      .click();
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/expenses/${fixture.expense.id}`,
        );
        expect(response.ok()).toBe(true);
        return assignment.parse(await response.json());
      })
      .toMatchObject({
        projectId: fixture.project.id,
        fieldResolutions: { projectId: { mode: "inherit" } },
      });
    await expect(
      page.getByText("purchase default", { exact: true }).first(),
    ).toBeVisible();
    await expectViewportBounded(page);
    await page.goto(`/expenses/${fixture.charge.id}`);
    await waitForAppHydration(page);
    await expect(page.getByText(/purchase allocation/i).first()).toBeVisible();
    await expectViewportBounded(page);
  });
}
