import {
  editDetailCell,
  editListCell,
  gotoAuthenticatedPage,
  openCommandPalette,
  waitForAppHydration,
  waitForEntityMutation,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test.describe("Project tracker", () => {
  test("projects data keeps project URL sorting out of embedded lists", async ({
    page,
  }) => {
    await page.goto("/projects?view=data&sort=startDate");

    await expect(
      page.getByRole("table", { name: "Projects Table" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole("table", { name: "Project-scoped Tasks Table" }),
    ).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Project-scoped Expenses Table" }),
    ).toBeVisible();

    // `startDate` is valid for Projects but not Tasks or Expenses. Those
    // embedded lists must keep their entity defaults instead of reading the
    // page owner's sort parameter.
    await expect(page.getByText(/BAD_REQUEST/)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("sort")).toBe("startDate");
  });

  test("tasks: quick-add creates a task and it appears in the table", async ({
    page,
  }) => {
    const name = `e2e task ${Date.now()}`;

    await page.goto("/tasks");

    await expect(
      page.getByRole("heading", { level: 1, name: "Tasks" }),
    ).toBeVisible({ timeout: 15000 });
    await waitForAppHydration(page);

    // `exact` — an empty list also renders its empty-state call-to-action
    // ("New Expense", "New Task"), which a substring match would tie with the
    // toolbar's own "New". Those buttons only started rendering once the empty
    // states stopped gating on a `/new` route these entities never had.
    await page.getByRole("button", { name: "New", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("New Task")).toBeVisible({
      timeout: 10000,
    });

    await dialog.getByLabel("Name").fill(name);
    await dialog.getByPlaceholder("Select trade").click();
    await page.getByRole("option", { name: "Other", exact: true }).click();
    await dialog.getByRole("button", { name: /^Create$/ }).click();

    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    await expect(page.getByText(name).first()).toBeVisible({
      timeout: 10000,
    });

    await page.goto(`/tasks?q=${encodeURIComponent(name)}`);

    await expect(
      page.getByRole("button", { name: `Name: ${name}` }),
    ).toBeVisible();
    await expect(page.getByText(name).first()).toBeVisible({
      timeout: 10000,
    });

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

    await expect(
      page.getByRole("heading", { level: 1, name: "Expenses" }),
    ).toBeVisible({ timeout: 15000 });
    await waitForAppHydration(page);

    await page.getByRole("button", { name: "New", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("New Expense")).toBeVisible({
      timeout: 10000,
    });

    await dialog.getByLabel("Name").fill(name);
    // spinbutton role disambiguates from the "Open Select cost type" trigger,
    // whose accessible name also contains "Cost".
    await dialog.getByRole("spinbutton", { name: "Cost" }).fill("24.99");
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

    await page.goto(`/expenses?q=${encodeURIComponent(name)}`);

    await expect(
      page.getByRole("button", { name: `Name: ${name}` }),
    ).toBeVisible();
    await expect(page.getByText(name).first()).toBeVisible({
      timeout: 10000,
    });

    // The Analytics tab consumes the same URL filter and lazily loads the
    // server-backed analyzer. This is deliberately a smoke assertion rather
    // than a chart snapshot: the complete aggregate table is the actionable
    // contract, and it must remain outside the eager Ledger chunk.
    await page.goto(`/expenses?view=analytics&q=${encodeURIComponent(name)}`);
    await expect(
      page.getByRole("heading", { level: 2, name: "Analyze" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole("table", { name: "Expense analysis" }),
    ).toBeVisible({ timeout: 15000 });
  });

  test("projects: quick-add creates a project and it appears on the dashboard", async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const name = `e2e project ${Date.now()}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;

    await page.goto("/projects");

    await expect(
      page.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeVisible({ timeout: 15000 });
    await waitForAppHydration(page);

    await page.getByRole("button", { name: "New Project" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("New Project")).toBeVisible({
      timeout: 10000,
    });

    await dialog.getByLabel("Name").fill(name);
    await dialog.getByRole("button", { name: /^Create$/ }).click();

    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "Data view" }).click();
    await expect(page.getByText(name).last()).toBeVisible({
      timeout: 10000,
    });

    const editedName = `${name} (edited)`;
    const nameCell = page.getByRole("cell").filter({
      has: page.getByRole("link", { name, exact: true }),
    });
    const committed = waitForEntityMutation(page);
    await editListCell(
      page,
      nameCell.getByRole("button", { name: "Edit value" }),
      editedName,
    );
    await committed;

    await gotoAuthenticatedPage(
      page,
      "/projects?view=data",
      page.getByRole("table", { name: "Projects Table" }),
    );
    await expect(
      page.getByRole("link", { name: editedName, exact: true }).last(),
    ).toBeVisible({ timeout: 10000 });
  });

  test("command palette: search deep-links a task straight to its detail page", async ({
    page,
  }) => {
    const name = `e2e palette task ${Date.now()}`;

    await page.goto("/tasks");
    await waitForAppHydration(page);
    await page.getByRole("button", { name: "New", exact: true }).click();

    const createDialog = page.getByRole("dialog");
    await expect(createDialog.getByText("New Task")).toBeVisible({
      timeout: 10000,
    });
    await createDialog.getByLabel("Name").fill(name);
    await createDialog.getByPlaceholder("Select trade").click();
    await page.getByRole("option", { name: "Other", exact: true }).click();
    await createDialog.getByRole("button", { name: /^Create$/ }).click();
    await expect(createDialog).not.toBeVisible({ timeout: 10000 });

    const palette = await openCommandPalette(page);
    const searchInput = palette.getByPlaceholder(
      "Search, jump to a page, or ask Cubby…",
    );
    await searchInput.fill(`task:${name}`);
    await expect(
      palette.getByRole("button", { name: "Clear Tasks scope" }),
    ).toBeVisible();
    await expect(palette.getByPlaceholder("Search Tasks…")).toHaveValue(name);

    await palette.getByPlaceholder("Search Tasks…").fill("");
    await palette.getByPlaceholder("Search Tasks…").press("Backspace");
    await expect(
      palette.getByRole("button", { name: "Clear Tasks scope" }),
    ).not.toBeVisible();
    await searchInput.fill(`tasks:${name}`);

    // Target the search-result name node specifically; the Ask Cubby action
    // below the results also contains the literal query. `.first()` guards
    // strict mode in case the query substring matches more than one row's name.
    const resultName = palette
      .locator("div.truncate.text-sm", { hasText: name })
      .first();
    await expect(resultName).toBeVisible({ timeout: 10000 });
    const resultItem = resultName.locator("xpath=ancestor::*[@cmdk-item]");
    await expect(resultItem.getByText("Task", { exact: true })).toBeVisible();
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

    const reopenedPalette = await openCommandPalette(page);
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

    await page.goto("/projects");
    await waitForAppHydration(page);
    await page.getByRole("button", { name: "New Project" }).click();

    const projectDialog = page.getByRole("dialog");
    await expect(projectDialog.getByText("New Project")).toBeVisible({
      timeout: 10000,
    });
    await projectDialog.getByLabel("Name").fill(projectName);
    await projectDialog.getByRole("button", { name: /^Create$/ }).click();
    await expect(projectDialog).not.toBeVisible({ timeout: 10000 });

    await page.goto("/tasks");
    await waitForAppHydration(page);
    await page.getByRole("button", { name: "New", exact: true }).click();

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

    await page.goto(`/tasks?q=${encodeURIComponent(taskName)}`);
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
    await waitForAppHydration(page);
    await page.getByRole("button", { name: "New Project" }).click();

    const createDialog = page.getByRole("dialog");
    await createDialog.getByLabel("Name").fill(name);
    await createDialog.getByRole("button", { name: /^Create$/ }).click();
    await expect(createDialog).not.toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "Data view" }).click();
    const projectLink = page.getByRole("link", { name, exact: true }).last();
    await expect(projectLink).toHaveAttribute(
      "href",
      /^\/projects\/PRJ-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/,
    );
    const projectPath = await projectLink.getAttribute("href");
    if (!projectPath) throw new Error("Created project link has no href");
    await page.goto(projectPath);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({
      timeout: 10000,
    });

    const resourcesCard = page.locator('[data-slot="card"]').filter({
      has: page.getByText("Resources", { exact: true }),
    });
    await expect(resourcesCard).toBeVisible();
    const overviewTitle = page.getByRole("heading", {
      name: "Overview",
      exact: true,
    });
    const resourcesTitle = page.getByRole("heading", {
      name: "Resources",
      exact: true,
    });
    await expect(overviewTitle).toBeVisible();
    await expect(resourcesTitle).toBeVisible();

    const driveRow = resourcesCard
      .getByText("Google Drive folder", { exact: true })
      .locator("..");
    const notionRow = resourcesCard
      .getByText("Notion page", { exact: true })
      .locator("..");

    await expect(driveRow.getByText("Add", { exact: true })).toBeVisible();
    await expect(notionRow.getByText("Add", { exact: true })).toBeVisible();

    await editDetailCell(
      page,
      driveRow.getByRole("button", { name: "Edit value" }),
      driveUrl,
    );
    await editDetailCell(
      page,
      notionRow.getByRole("button", { name: "Edit value" }),
      notionUrl,
    );

    const driveLink = driveRow.getByRole("link", { name: "Open folder" });
    const notionLink = notionRow.getByRole("link", { name: "Open page" });
    await expect(driveLink).toHaveAttribute("href", driveUrl);
    await expect(driveLink).toHaveAttribute("target", "_blank");
    await expect(driveLink).toHaveAttribute("rel", "noopener noreferrer");
    await expect(notionLink).toHaveAttribute("href", notionUrl);
    await expect(notionLink).toHaveAttribute("target", "_blank");
    await expect(notionLink).toHaveAttribute("rel", "noopener noreferrer");

    await driveRow.getByRole("button", { name: "Edit value" }).click();
    const rejectedEditor = page.locator(
      '[data-slot="cell-editor-overlay"] input',
    );
    await expect(rejectedEditor).toBeVisible();
    await rejectedEditor.fill(
      "https://notion.so/Wrong-provider-0123456789abcdef",
    );
    await rejectedEditor.press("Enter");
    await expect(
      page.getByText("Enter a valid Google Drive folder URL").first(),
    ).toBeVisible({ timeout: 10000 });
    // The mutation's toast can render before useEditorCommit's finally block
    // resets its pending state. Cancel only after the rejected attempt has
    // completely settled so the next edit cannot overlap that lifecycle.
    await expect(rejectedEditor).toBeEnabled({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(rejectedEditor).toHaveCount(0);
    await expect(driveLink).toHaveAttribute("href", driveUrl);

    await editDetailCell(
      page,
      driveRow.getByRole("button", { name: "Edit value" }),
      "",
    );
    await expect(driveLink).toHaveCount(0);
    await expect(driveRow.getByText("Add", { exact: true })).toBeVisible();

    await editDetailCell(
      page,
      notionRow.getByRole("button", { name: "Edit value" }),
      "",
    );
    await expect(notionLink).toHaveCount(0);
    await expect(notionRow.getByText("Add", { exact: true })).toBeVisible();
  });

  test("mobile viewport: expense quick-add renders as a bottom sheet and still submits", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    const name = `e2e mobile expense ${Date.now()}`;

    await page.goto("/expenses");
    await expect(
      page.getByRole("heading", { level: 1, name: "Expenses" }),
    ).toBeVisible({ timeout: 15000 });
    await waitForAppHydration(page);

    await page.getByRole("button", { name: "New", exact: true }).click();

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
    await sheet.getByPlaceholder("Select cost type").click();
    await page.getByRole("option", { name: "Materials", exact: true }).click();
    await sheet.getByPlaceholder("Select trade").click();
    await page.getByRole("option", { name: "Other", exact: true }).click();
    await sheet.getByRole("button", { name: /^Create$/ }).click();

    await expect(sheet).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByText(name).first()).toBeVisible({
      timeout: 10000,
    });
  });
});
