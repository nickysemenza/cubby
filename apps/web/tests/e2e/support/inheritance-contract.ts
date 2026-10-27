import { fieldEnvelope } from "@cubby/schemas/field-envelope";
import { z } from "zod";

import { seedInheritancePrerequisite } from "../fixtures/finance";
import {
  expectViewportBounded,
  gotoAuthenticatedPage,
  readExpense,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const assignment = z.object({
  fields: z.object({
    projectId: fieldEnvelope(z.string().nullable(), z.string()),
  }),
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
    await page
      .getByRole("button", { name: "How project is determined", exact: true })
      .click();
    await expect(useInherited).toBeVisible();
    expect(
      await readExpense(page, fixture.expense.id, assignment),
    ).toMatchObject({
      fields: {
        projectId: {
          current: {
            assignment: { kind: "value", value: fixture.project.id },
            controls: { kind: "editable", reset: { kind: "available" } },
          },
          result: {
            decision: { outcome: { kind: "value", value: fixture.project.id } },
          },
        },
      },
    });
    const panel = page.getByRole("dialog");
    await expect(
      panel
        .getByText("With inherited values:", { exact: true })
        .locator("..")
        .locator(`a[href="/projects/${fixture.project.id}"]`),
    ).toBeVisible();
    await useInherited.click();
    await expect
      .poll(() => readExpense(page, fixture.expense.id, assignment))
      .toMatchObject({
        fields: {
          projectId: {
            current: {
              assignment: { kind: "inherit" },
              controls: { kind: "editable", reset: { kind: "unavailable" } },
            },
            result: {
              decision: {
                outcome: { kind: "value", value: fixture.project.id },
                provenance: { kind: "inherited" },
              },
            },
          },
        },
      });
    await expect(
      panel.getByRole("heading", { name: "Effective result", exact: true }),
    ).toBeVisible();
    await expect(useInherited).toHaveCount(0);
    await expectViewportBounded(page);
  });
}
