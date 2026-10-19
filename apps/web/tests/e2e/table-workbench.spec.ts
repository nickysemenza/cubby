import { householdDaysFromNow } from "~/lib/household-date";

import { createFixture } from "./fixtures/core";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Regressions: embedded relation tables never passed their grouping, sorted
// by name, and repeated the column pointing back at the record they sit on.
test("Project Tasks group by status, latest due first, without a Project column", async ({
  page,
}) => {
  const prefix = `Grouped tasks ${Date.now()}`;
  const project = await createFixture(page, "project", { name: prefix });
  const task = (name: string, status: string, due: number) =>
    createFixture(page, "task", {
      name: `${prefix} ${name}`,
      trade: "other",
      projectId: project.id,
      status,
      dueDate: householdDaysFromNow(due),
    });
  await task("sooner", "in_progress", 3);
  await task("later", "in_progress", 20);
  await task("finished", "done", 5);

  await gotoAuthenticatedPage(page, `/projects/${project.id}`);
  const tasks = page.getByRole("table", { name: "Tasks", exact: true });
  await expect(
    tasks.getByRole("heading", { name: "In progress", exact: true }),
  ).toBeVisible();
  await expect(
    tasks.getByRole("heading", { name: "Done", exact: true }),
  ).toBeVisible();
  const names = await tasks
    .getByRole("row")
    .filter({ hasText: prefix })
    .allTextContents();
  const position = (name: string) =>
    names.findIndex((text) => text.includes(`${prefix} ${name}`));
  expect(position("later")).toBeLessThan(position("sooner"));
  await expect(
    tasks.getByRole("columnheader", { name: /^Project/ }),
  ).toHaveCount(0);
});

test("a column header menu groups and ungroups the list", async ({ page }) => {
  const prefix = `Header menu ${Date.now()}`;
  await createFixture(page, "task", {
    name: `${prefix} open`,
    trade: "other",
    status: "in_progress",
  });
  await createFixture(page, "task", {
    name: `${prefix} closed`,
    trade: "other",
    status: "done",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, `/tasks?q=${encodeURIComponent(prefix)}`);
  const openMenu = () =>
    page.getByRole("button", { name: "Status column menu" }).click();

  await openMenu();
  await page.getByRole("menuitem", { name: /^Group by Status/ }).click();
  await expect(page).toHaveURL(/groupBy=status/);
  await expect(
    page.getByRole("heading", { name: "In progress", exact: true }),
  ).toBeVisible();

  await openMenu();
  await page.getByRole("menuitem", { name: "Ungroup" }).click();
  await expect(page).not.toHaveURL(/groupBy=/);
});

// Regression: the Decisions table showed ten rows behind a pager and opened
// details in a different panel from entity tables.
test("AI Decisions lists every decision by entity and opens the shared panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, "/ai");
  const decisions = page.getByRole("table", { name: "Decisions" });
  await expect(
    decisions.getByRole("heading", { name: /^Cookbook\b/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Go to next page" }),
  ).toHaveCount(0);

  await decisions
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "Cookbook", exact: true }) })
    .first()
    .click();
  const panel = page.getByRole("complementary", { name: "Decision detail" });
  await expect(panel.getByRole("heading", { name: "Rules" })).toBeVisible();
});
