import { expect, test } from "@playwright/test";

/**
 * Coverage for the new (DB-backed) project-tracker surfaces: /projects
 * (dashboard), /tasks and /purchases (RTable list pages with quick-add
 * dialogs). The E2E suite runs against a fresh IntegresQL database, so these
 * pages render with no seed data — the dashboard's empty state and the two
 * list pages' empty tables are all we can assert on load; the interesting
 * coverage is the quick-add → row-appears round trip.
 *
 * Projects are also reachable via the project SelectField in the
 * task/purchase quick-add dialogs, which is left at its default "None" in
 * those two tests to avoid the FilterableCombobox-inside-Dialog combination
 * form-utils.tsx flags as untested for nested-dialog use (it's built for
 * page-level forms, not `DialogCompatibleCombobox`).
 */

test.describe("Project tracker", () => {
  test("projects dashboard renders signed in with no data", async ({
    page,
  }) => {
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeVisible({ timeout: 15000 });

    // Empty-state summary cards render zeroed counts rather than crashing.
    await expect(page.getByText("Active Projects")).toBeVisible();
    await expect(page.getByText("Active Tasks")).toBeVisible();
    await expect(page.getByText("Total Spend")).toBeVisible();

    // No React error boundary / router error page.
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  });

  test("tasks: quick-add creates a task and it appears in the table", async ({
    page,
  }) => {
    const name = `e2e task ${Date.now()}`;

    await page.goto("/tasks");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { level: 1, name: "Tasks" }),
    ).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "New" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("New Task")).toBeVisible({
      timeout: 10000,
    });

    await dialog.getByLabel("Name").fill(name);
    await dialog.getByRole("button", { name: /^Create$/ }).click();

    // Dialog closes on success (onSuccess resets + calls onOpenChange(false)).
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    await expect(page.getByText(name).first()).toBeVisible({
      timeout: 10000,
    });

    // Command-palette deep link: /tasks?q=<name> seeds the "name" filter so
    // the matched task is visible immediately instead of buried pages deep.
    await page.goto(`/tasks?q=${encodeURIComponent(name)}`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByPlaceholder("Search tasks...")).toHaveValue(name);
    await expect(page.getByText(name).first()).toBeVisible({
      timeout: 10000,
    });

    // The name column links to the task's detail page (/tasks/$id).
    await page.getByRole("link", { name }).first().click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({
      timeout: 10000,
    });
  });

  test("purchases: quick-add creates a purchase and cost renders as currency", async ({
    page,
  }) => {
    const name = `e2e purchase ${Date.now()}`;

    await page.goto("/purchases");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { level: 1, name: "Purchases" }),
    ).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "New" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("New Purchase")).toBeVisible({
      timeout: 10000,
    });

    await dialog.getByLabel("Name").fill(name);
    await dialog.getByLabel("Cost").fill("24.99");
    await dialog.getByRole("button", { name: /^Create$/ }).click();

    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    await expect(page.getByText(name).first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText("$24.99").first()).toBeVisible({
      timeout: 10000,
    });

    // Command-palette deep link: /purchases?q=<name> seeds the "name" filter
    // so the matched purchase is visible immediately.
    await page.goto(`/purchases?q=${encodeURIComponent(name)}`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByPlaceholder("Search purchases...")).toHaveValue(
      name,
    );
    await expect(page.getByText(name).first()).toBeVisible({
      timeout: 10000,
    });
  });

  test("projects: quick-add creates a project and it appears on the dashboard", async ({
    page,
  }) => {
    const name = `e2e project ${Date.now()}`;

    await page.goto("/projects");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "New Project" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("New Project")).toBeVisible({
      timeout: 10000,
    });

    await dialog.getByLabel("Name").fill(name);
    await dialog.getByRole("button", { name: /^Create$/ }).click();

    // Dialog closes on success (onSuccess resets + calls onOpenChange(false)).
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    // Switch to the Data tab, where the project table renders names directly
    // (the default Overview tab is charts-only) to confirm the row landed. A
    // brand-new "planning"-status project with no purchases/estimate also
    // matches "Needs Attention"'s stalled/missing-estimate `ProjectPill`s,
    // which render earlier in the DOM but stay inside collapsed `<details>`
    // (hidden) — use `.last()` to land on the always-visible table row.
    await page.getByRole("button", { name: "Data view" }).click();
    await expect(page.getByText(name).last()).toBeVisible({
      timeout: 10000,
    });
  });
});
