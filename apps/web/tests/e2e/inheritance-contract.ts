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
    // The shell's hydrated marker precedes the streamed detail subtree, so on
    // a slow WebKit run the first click can land on a server-rendered button
    // whose React onClick is not attached yet: the DOM focuses it and nothing
    // happens. The handler flips `disabled` while the mutation is pending and
    // the button unmounts once the mode is `inherit`, so retry the click until
    // one of those is observed. Repeating the reset patch is idempotent.
    const useInherited = page
      .getByRole("button", { name: "Use inherited value", exact: true })
      .first();
    await expect(async () => {
      await useInherited.click({ timeout: 2_000 });
      await expect(async () => {
        const responded =
          (await useInherited.count()) === 0 ||
          (await useInherited.isDisabled());
        expect(responded).toBe(true);
      }).toPass({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
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
    await expect(
      explanation.getByRole("link", { name: fixture.project.id, exact: true }),
    ).toHaveAttribute("href", `/projects/${fixture.project.id}`);
    await expect(
      explanation.getByText("Stored override", { exact: true }),
    ).toHaveCount(0);
    await expectViewportBounded(page);
    if (test.info().project.name === "Authenticated tests") {
      await page.goto(`/purchases/${fixture.purchase.id}`);
      await waitForAppHydration(page);
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
    }
  });
}
