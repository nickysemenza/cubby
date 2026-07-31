import { expect, test } from "@playwright/test";
import { fillCellEditor } from "./e2e-helpers";

/**
 * Coverage for the new (DB-backed) project-tracker surfaces: /projects
 * (dashboard), /tasks and /expenses (RTable list pages with quick-add
 * dialogs). The E2E suite runs against a fresh IntegresQL database, so these
 * pages render with no seed data — the dashboard's empty state and the two
 * list pages' empty tables are all we can assert on load; the interesting
 * coverage is the quick-add → row-appears round trip.
 *
 * Projects are also reachable via the project SelectField in the
 * task/expense quick-add dialogs, which is left at its default "None" in
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

    // Empty-state summary tiles render zeroed counts rather than crashing.
    // Exact match: the "Needs Attention" banner's "N active projects missing…"
    // text also substring-matches "Active Projects" case-insensitively, and
    // the section listing the project cards is titled "Projects" (not
    // "Active Projects", to avoid duplicating the tile's own label) — see
    // `OverviewView`'s `summaryItems` in projects-dashboard.tsx for the
    // current tile set: Active Projects / Open Tasks / Spend (+committed
    // caption).
    await expect(
      page.getByText("Active Projects", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Open Tasks", { exact: true })).toBeVisible();
    await expect(page.getByText("Spend", { exact: true })).toBeVisible();

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

  test("expenses: quick-add creates an expense and cost renders as currency", async ({
    page,
  }) => {
    const name = `e2e expense ${Date.now()}`;

    await page.goto("/expenses");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { level: 1, name: "Expenses" }),
    ).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "New" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("New Expense")).toBeVisible({
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

    // Command-palette deep link: /expenses?q=<name> seeds the "name" filter
    // so the matched expense is visible immediately.
    await page.goto(`/expenses?q=${encodeURIComponent(name)}`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByPlaceholder("Search expenses...")).toHaveValue(name);
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
    // brand-new "planning"-status project with no expenses/estimate also
    // matches "Needs Attention"'s stalled/missing-estimate `ProjectPill`s,
    // which render earlier in the DOM but stay inside collapsed `<details>`
    // (hidden) — use `.last()` to land on the always-visible table row.
    await page.getByRole("button", { name: "Data view" }).click();
    await expect(page.getByText(name).last()).toBeVisible({
      timeout: 10000,
    });

    // The Data tab's project table (`shared.tsx`'s `ProjectTable`, migrated
    // onto `useEntityList`) has an inline-editable name column, same as
    // tasks/expenses. `ProjectPill` (Needs Attention) renders a Link, not a
    // button, so this is unambiguous even before the edit.
    //
    // Sheets-style select-then-edit: inside the cell-selection grid a single
    // click only SELECTS the cell; the editor opens on double-click (or Enter).
    // Scope through the cell's name link, then double-click its separate edit
    // button. The name itself navigates to the detail page.
    const editedName = `${name} (edited)`;
    const nameCell = page.getByRole("cell").filter({
      has: page.getByRole("link", { name, exact: true }),
    });
    await nameCell.getByRole("button", { name: "Edit value" }).dblclick();
    await fillCellEditor(page, editedName);

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
    const searchInput = palette.getByPlaceholder(
      "Search, jump to a page, or ask Cubby…",
    );
    await searchInput.fill(`task:${name}`);
    await expect(
      palette.getByRole("button", { name: "Clear Tasks scope" }),
    ).toBeVisible();
    await expect(palette.getByPlaceholder("Search Tasks…")).toHaveValue(name);

    // Empty-query Backspace removes the scope without closing the palette.
    await palette.getByPlaceholder("Search Tasks…").fill("");
    await palette.getByPlaceholder("Search Tasks…").press("Backspace");
    await expect(
      palette.getByRole("button", { name: "Clear Tasks scope" }),
    ).not.toBeVisible();
    await searchInput.fill(`tasks:${name}`);

    // Target the search-result name node specifically; the Ask Cubby action
    // below the results also contains the literal query.
    const resultName = palette.locator("div.truncate.text-sm", {
      hasText: name,
    });
    await expect(resultName).toBeVisible({ timeout: 10000 });
    const resultItem = resultName.locator("xpath=ancestor::*[@cmdk-item]");
    await expect(resultItem.getByText("task", { exact: true })).toBeVisible();
    await expect(resultItem).not.toContainText("pts");
    const optionTexts = await palette.getByRole("option").allTextContents();
    const resultIndex = optionTexts.findIndex((text) => text.includes(name));
    const askIndex = optionTexts.findIndex((text) =>
      text.includes(`Ask Cubby: "${name}"`),
    );
    expect(resultIndex).toBeGreaterThanOrEqual(0);
    expect(askIndex).toBeGreaterThan(resultIndex);
    await resultName.click();

    // Lands on the real detail route (/tasks/$shortcode), not the /tasks list.
    await expect(page).toHaveURL(
      /\/tasks\/TSK-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/,
      { timeout: 10000 },
    );
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({
      timeout: 10000,
    });

    // The exhaustive search page receives the clean query and selected type.
    await page.getByRole("button", { name: "Search" }).click();
    const reopenedPalette = page.getByRole("dialog");
    await reopenedPalette
      .getByPlaceholder("Search, jump to a page, or ask Cubby…")
      .fill(`task:${name}`);
    await reopenedPalette
      .getByText(`See all results for "${name}"`, { exact: true })
      .click();
    await expect(page).toHaveURL(/\/search\?/);
    const searchUrl = new URL(page.url());
    expect(searchUrl.searchParams.get("q")).toBe(name);
    expect(searchUrl.searchParams.get("type")).toBe("task");
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
      /^\/projects\/PRJ-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/,
    );
  });

  test("project detail: resource links validate, render safely, and can be removed", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const name = `e2e resource project ${Date.now()}`;
    const driveUrl =
      "https://drive.google.com/drive/u/1/folders/e2e-drive?usp=sharing";
    const notionUrl =
      "https://app.notion.com/p/nickysemenza/Backyard-Project-Main-Page-d4ffaba2e4b240ebb4aa8b7d80a7aabb?source=copy_link";

    await page.goto("/projects");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New Project" }).click();

    const createDialog = page.getByRole("dialog");
    await createDialog.getByLabel("Name").fill(name);
    await createDialog.getByRole("button", { name: /^Create$/ }).click();
    await expect(createDialog).not.toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "Data view" }).click();
    await page.getByRole("link", { name, exact: true }).last().click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({
      timeout: 10000,
    });

    const resourcesCard = page.locator('[data-slot="card"]').filter({
      has: page.getByText("Resources", { exact: true }),
    });
    await expect(resourcesCard).toBeVisible();
    const overviewTitle = page.getByText("Overview", { exact: true });
    const resourcesTitle = page.getByText("Resources", { exact: true });
    await expect(overviewTitle).toBeVisible();
    await expect(resourcesTitle).toBeVisible();

    const driveRow = resourcesCard
      .getByText("Google Drive folder", { exact: true })
      .locator("..");
    const notionRow = resourcesCard
      .getByText("Notion page", { exact: true })
      .locator("..");

    // Both fixed rows are present before either optional URL has been set.
    await expect(driveRow.getByText("Add", { exact: true })).toBeVisible();
    await expect(notionRow.getByText("Add", { exact: true })).toBeVisible();

    await driveRow.getByRole("button", { name: "Edit value" }).click();
    await fillCellEditor(page, driveUrl);

    await notionRow.getByRole("button", { name: "Edit value" }).click();
    await fillCellEditor(page, notionUrl);

    const driveLink = driveRow.getByRole("link", { name: "Open folder" });
    const notionLink = notionRow.getByRole("link", { name: "Open page" });
    await expect(driveLink).toHaveAttribute("href", driveUrl);
    await expect(driveLink).toHaveAttribute("target", "_blank");
    await expect(driveLink).toHaveAttribute("rel", "noopener noreferrer");
    await expect(notionLink).toHaveAttribute("href", notionUrl);
    await expect(notionLink).toHaveAttribute("target", "_blank");
    await expect(notionLink).toHaveAttribute("rel", "noopener noreferrer");

    // A provider mismatch is rejected and leaves the last valid anchor intact.
    await driveRow.getByRole("button", { name: "Edit value" }).click();
    await fillCellEditor(
      page,
      "https://notion.so/Wrong-provider-0123456789abcdef",
    );
    await expect(
      page.getByText("Enter a valid Google Drive folder URL").first(),
    ).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Escape");
    await expect(driveLink).toHaveAttribute("href", driveUrl);

    // Clearing the shared inline text editor removes each optional URL.
    await driveRow.getByRole("button", { name: "Edit value" }).click();
    await fillCellEditor(page, "");
    await expect(driveLink).toHaveCount(0);
    await expect(driveRow.getByText("Add", { exact: true })).toBeVisible();

    await notionRow.getByRole("button", { name: "Edit value" }).click();
    await fillCellEditor(page, "");
    await expect(notionLink).toHaveCount(0);
    await expect(notionRow.getByText("Add", { exact: true })).toBeVisible();
  });

  test("mobile viewport: expense quick-add renders as a bottom sheet and still submits", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    const name = `e2e mobile expense ${Date.now()}`;

    await page.goto("/expenses");
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { level: 1, name: "Expenses" }),
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

    await expect(sheet.getByText("New Expense")).toBeVisible({
      timeout: 10000,
    });
    await sheet.getByLabel("Name").fill(name);
    // spinbutton role disambiguates from the "Open Select cost type" trigger,
    // whose accessible name also contains "Cost" (same fix as the desktop
    // expenses quick-add test above).
    await sheet.getByRole("spinbutton", { name: "Cost" }).fill("12.34");
    // costType + trade are required (NOT NULL).
    await sheet.getByPlaceholder("Select cost type").click();
    await page.getByRole("option", { name: "Materials", exact: true }).click();
    await sheet.getByPlaceholder("Select trade").click();
    await page.getByRole("option", { name: "Other", exact: true }).click();
    await sheet.getByRole("button", { name: /^Create$/ }).click();

    // Sheet closes and the row lands, same round trip as the desktop
    // expenses quick-add test above.
    await expect(sheet).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByText(name).first()).toBeVisible({
      timeout: 10000,
    });
  });
});
