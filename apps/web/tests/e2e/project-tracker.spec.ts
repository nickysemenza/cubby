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
 * page-level forms, not `DialogCompatibleCombobox`). The project-inline-link
 * test below *does* drive that Project `SelectField` — it's the plain
 * `FilterableCombobox` (base-ui, click-then-click-option, no search-input
 * step), not the async `DialogCompatibleCombobox` the note above is about.
 *
 * Three more surfaces added this round (tracker-first-class-previews):
 *  1. Command palette deep-linking search hits straight to their detail route
 *     (Phase B consolidation — the palette dropped its bespoke tracker
 *     section in favor of ranked global search + `getSearchResultRoute`).
 *     Lexical search (ILIKE, see `search.ts`) matches a just-created task by
 *     name with no embeddings needed, so this runs the real palette flow
 *     rather than falling back to a direct-navigation smoke test.
 *  2. `EntityInlineLink` on the task detail page's Project field renders a
 *     real `/projects/$id` anchor (Phase A hovercards) — hover-to-open-card
 *     is flaky in E2E, so this only asserts the link/href, not the card.
 *  3. `ResponsiveDialog` (Phase C) renders quick-add as a bottom `Sheet`
 *     (not a centered `Dialog`) under the 768px mobile breakpoint, and the
 *     create flow still round-trips at that viewport.
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
    // trade is required (NOT NULL) — same click-then-click-option drive as
    // the Project SelectField below.
    await dialog.getByPlaceholder("Select trade").click();
    await page.getByRole("option", { name: "Other", exact: true }).click();
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
    // spinbutton role disambiguates from the "Open Select cost type" trigger,
    // whose accessible name also contains "Cost".
    await dialog.getByRole("spinbutton", { name: "Cost" }).fill("24.99");
    // costType + trade are required (NOT NULL).
    await dialog.getByPlaceholder("Select cost type").click();
    await page.getByRole("option", { name: "Materials", exact: true }).click();
    await dialog.getByPlaceholder("Select trade").click();
    await page.getByRole("option", { name: "Other", exact: true }).click();
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

    // The Data tab's project table (`shared.tsx`'s `ProjectTable`, migrated
    // onto `useEntityList`) has an inline-editable name column, same as
    // tasks/purchases. `ProjectPill` (Needs Attention) renders a Link, not a
    // button, so this is unambiguous even before the edit.
    const editedName = `${name} (edited)`;
    await page.getByRole("button", { name }).click();
    const nameInput = page.locator("input:focus");
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill(editedName);
    await nameInput.press("Enter");

    // Assert the edited value renders (react-query invalidation round trip) —
    // more stable than a full page reload, and still proves the mutation
    // persisted (not just an optimistic client-side echo).
    await expect(page.getByText(editedName).last()).toBeVisible({
      timeout: 10000,
    });
  });

  test("command palette: search deep-links a task straight to its detail page", async ({
    page,
  }) => {
    const name = `e2e palette task ${Date.now()}`;

    // Seed a task the palette can find.
    await page.goto("/tasks");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New" }).click();

    const createDialog = page.getByRole("dialog");
    await expect(createDialog.getByText("New Task")).toBeVisible({
      timeout: 10000,
    });
    await createDialog.getByLabel("Name").fill(name);
    await createDialog.getByPlaceholder("Select trade").click();
    await page.getByRole("option", { name: "Other", exact: true }).click();
    await createDialog.getByRole("button", { name: /^Create$/ }).click();
    await expect(createDialog).not.toBeVisible({ timeout: 10000 });

    // Open the palette via the header's search trigger — same affordance as
    // Cmd/Ctrl+K (owned by __root.tsx), stabler to drive headlessly than a
    // synthetic key chord.
    await page.getByRole("button", { name: "Search" }).click();

    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible({ timeout: 10000 });
    await palette
      .getByPlaceholder("Search, jump to a page, or ask Cubby…")
      .fill(name);

    // Target the search-result name node specifically (`className="truncate
    // text-sm"` in search-utils.tsx's result renderer) rather than
    // `getByText(name)` — the "Ask Cubby: "<query>"" item (pinned above the
    // results while searching) also contains the literal query text, and its
    // wrapper span doesn't share this class pair.
    const resultName = palette.locator("div.truncate.text-sm", {
      hasText: name,
    });
    await expect(resultName).toBeVisible({ timeout: 10000 });
    await resultName.click();

    // Lands on the real detail route (/tasks/$id), not the /tasks list.
    await expect(page).toHaveURL(/\/tasks\/[a-f0-9-]+$/, { timeout: 10000 });
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({
      timeout: 10000,
    });
  });

  test("task detail: the parent-project field is a real link to /projects/$id", async ({
    page,
  }) => {
    const projectName = `e2e link project ${Date.now()}`;
    const taskName = `e2e link task ${Date.now()}`;

    // Create a project to link the task to.
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New Project" }).click();

    const projectDialog = page.getByRole("dialog");
    await expect(projectDialog.getByText("New Project")).toBeVisible({
      timeout: 10000,
    });
    await projectDialog.getByLabel("Name").fill(projectName);
    await projectDialog.getByRole("button", { name: /^Create$/ }).click();
    await expect(projectDialog).not.toBeVisible({ timeout: 10000 });

    // Create a task and attach it to that project via the quick-add's
    // Project field — a plain `FilterableCombobox` (base-ui), not the async
    // `DialogCompatibleCombobox`: click to open, click the option, done (no
    // search-input step, so it doesn't hit the nested-dialog flakiness the
    // other quick-add tests avoid).
    await page.goto("/tasks");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New" }).click();

    const taskDialog = page.getByRole("dialog");
    await expect(taskDialog.getByText("New Task")).toBeVisible({
      timeout: 10000,
    });
    await taskDialog.getByLabel("Name").fill(taskName);
    await taskDialog.getByPlaceholder("Select trade").click();
    await page.getByRole("option", { name: "Other", exact: true }).click();
    await taskDialog.getByPlaceholder("Select project").click();
    await page.getByRole("option", { name: projectName }).click();
    await taskDialog.getByRole("button", { name: /^Create$/ }).click();
    await expect(taskDialog).not.toBeVisible({ timeout: 10000 });

    // Navigate to the task's detail page via the filtered list link (same
    // deep-link pattern the tasks quick-add test above already exercises).
    await page.goto(`/tasks?q=${encodeURIComponent(taskName)}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("link", { name: taskName }).first().click();
    await expect(
      page.getByRole("heading", { level: 1, name: taskName }),
    ).toBeVisible({ timeout: 10000 });

    // The Project field/hero-stat render through EntityInlineLink → a real
    // <a> to the project detail route, not inert text.
    const projectLink = page
      .getByRole("link", { name: new RegExp(projectName) })
      .first();
    await expect(projectLink).toBeVisible({ timeout: 10000 });
    await expect(projectLink).toHaveAttribute(
      "href",
      /^\/projects\/[a-f0-9-]+$/,
    );
  });

  test("mobile viewport: purchase quick-add renders as a bottom sheet and still submits", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    const name = `e2e mobile purchase ${Date.now()}`;

    await page.goto("/purchases");
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { level: 1, name: "Purchases" }),
    ).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "New" }).click();

    // Phase C: ResponsiveDialog renders a bottom Sheet (not a centered
    // Dialog) under the 768px mobile breakpoint — SheetContent's
    // `side="bottom"` stamps `data-side="bottom"` (sheet.tsx).
    const sheet = page.locator(
      '[data-slot="sheet-content"][data-side="bottom"]',
    );
    await expect(sheet).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0);

    await expect(sheet.getByText("New Purchase")).toBeVisible({
      timeout: 10000,
    });
    await sheet.getByLabel("Name").fill(name);
    // spinbutton role disambiguates from the "Open Select cost type" trigger,
    // whose accessible name also contains "Cost" (same fix as the desktop
    // purchases quick-add test above).
    await sheet.getByRole("spinbutton", { name: "Cost" }).fill("12.34");
    // costType + trade are required (NOT NULL).
    await sheet.getByPlaceholder("Select cost type").click();
    await page.getByRole("option", { name: "Materials", exact: true }).click();
    await sheet.getByPlaceholder("Select trade").click();
    await page.getByRole("option", { name: "Other", exact: true }).click();
    await sheet.getByRole("button", { name: /^Create$/ }).click();

    // Sheet closes and the row lands, same round trip as the desktop
    // purchases quick-add test above.
    await expect(sheet).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByText(name).first()).toBeVisible({
      timeout: 10000,
    });
  });
});
