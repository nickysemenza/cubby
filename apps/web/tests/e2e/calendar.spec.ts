import { expect, test } from "@playwright/test";
import { waitForDndMutation } from "./dnd-helpers";
import { createTask } from "./e2e-helpers";

test("calendar events open an anchored editor, save atomically, and restore focus", async ({
  page,
}) => {
  const stamp = Date.now();
  const name = `e2e inline calendar task ${stamp}`;
  const updatedName = `e2e edited calendar task ${stamp}`;
  await createTask(page, name, { dueDate: "2026-07-16" });
  await page.goto("/calendar?date=2026-07-01");
  await page.waitForLoadState("networkidle");

  const event = page.getByRole("button", { name: `${name}, All day` });
  await event.click();
  const editor = page.getByRole("dialog", { name });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Name")).toHaveValue(name);

  await editor.getByLabel("Name").fill(updatedName);
  const committed = waitForDndMutation(page, "task.update");
  await editor.getByRole("button", { name: "Save" }).click();
  await committed;
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `${updatedName}, All day` }),
  ).toBeVisible();

  const updatedEvent = page.getByRole("button", {
    name: `${updatedName}, All day`,
  });
  await updatedEvent.click();
  await page.keyboard.press("Escape");
  await expect(updatedEvent).toBeFocused();
});

test("calendar opens a date drawer and prefills quick creation", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/calendar?date=2026-07-01");
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByRole("heading", { level: 1, name: "Calendar" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter" })).toBeVisible();

  const july14 = page
    .locator(
      '[data-slot="event-calendar-month-cell"]:not([data-outside="true"])',
    )
    .filter({
      has: page.locator(
        '[data-slot="event-calendar-month-day-number"]:text-is("14")',
      ),
    });
  await expect(july14).toHaveCount(1);
  await july14.locator('button[data-slot="event-calendar-day-add"]').click();

  await expect(page).toHaveURL(/day=2026-07-14/);
  await expect(
    page.getByRole("heading", { name: "Tuesday, July 14" }),
  ).toBeVisible();
  await expect(page.getByText("Nothing planned yet.")).toBeVisible();

  // Scoped to the day sheet on purpose. This used to be `.last()`, which only
  // disambiguated it from the kind-toggle row that the filter bar replaced —
  // leaving the assertion silently dependent on there now being exactly one
  // match anywhere on the page.
  const daySheet = page.getByRole("dialog", { name: "Tuesday, July 14" });
  await daySheet.getByRole("button", { name: "Meals" }).click();
  const mealDialog = page.getByRole("dialog", { name: "New Meal" });
  await expect(mealDialog).toBeVisible();
  await expect(
    mealDialog.getByRole("textbox", { name: "Date", exact: true }),
  ).toHaveValue("Jul 14, 2026");
  expect(pageErrors).toEqual([]);
});

test("calendar filters are URL-backed and survive a reload", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // The pre-filter-bar URL shape. Both keys were kept verbatim so bookmarks
  // and shared links from before the manifest bar still resolve.
  await page.goto(
    "/calendar?date=2026-07-01&kinds=meal,task&projectKinds=renovation",
  );
  await page.waitForLoadState("networkidle");

  const showFilter = page.getByRole("button", { name: "Show: Meals, Tasks" });
  const projectKind = page.getByRole("button", {
    name: "Project kind: Renovation",
  });
  await expect(showFilter).toBeVisible();
  await expect(projectKind).toBeVisible();

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveURL(/kinds=meal%2Ctask|kinds=meal,task/);
  await expect(showFilter).toBeVisible();
  await expect(projectKind).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("weekly planning is URL-backed and navigates by exact weeks", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/calendar?date=2026-08-18&period=week&kinds=meal,task");
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByRole("button", { name: "Week", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "Aug 16–22, 2026" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-slot="calendar-week-summary"] button'),
  ).toHaveCount(7);
  await expect(
    page.locator('[data-slot="event-calendar-week-day"]'),
  ).toHaveCount(7);

  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page).toHaveURL(/date=2026-08-25/);
  await expect(page).toHaveURL(/period=week/);
  await expect(page).toHaveURL(/kinds=meal%2Ctask|kinds=meal,task/);

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("button", { name: "Week", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Today" }).click();
  await expect(page).not.toHaveURL(/date=/);
  await expect(page).toHaveURL(/period=week/);
  await expect(page).toHaveURL(/kinds=meal%2Ctask|kinds=meal,task/);

  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page).not.toHaveURL(/period=/);
  expect(pageErrors).toEqual([]);
});

test("the fortnight grid spans two week-aligned rows and steps 14 days", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // A Thursday anchor: the grid has to snap back to its Sunday, not start here.
  await page.goto("/calendar?date=2026-08-20&period=fortnight&kinds=meal,task");
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByRole("button", { name: "Fortnight", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "Aug 16–29, 2026" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-slot="event-calendar-month-cell"]'),
  ).toHaveCount(14);
  // Active === visible for a fortnight, so no day is dimmed as an outside day.
  await expect(
    page.locator('[data-slot="event-calendar-month-cell"][data-outside]'),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Next fortnight" }).click();
  await expect(page).toHaveURL(/date=2026-09-03/);
  await expect(
    page.getByRole("heading", { name: "Aug 30–Sep 12, 2026" }),
  ).toBeVisible();

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("button", { name: "Fortnight", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator('[data-slot="event-calendar-month-cell"]'),
  ).toHaveCount(14);

  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page).not.toHaveURL(/period=/);
  await expect(
    page.locator('[data-slot="event-calendar-month-cell"]'),
  ).toHaveCount(42);
  expect(pageErrors).toEqual([]);
});

test("the Meals calendar preserves its legacy anchor in Week mode", async ({
  page,
}) => {
  await page.goto("/meals?week=2026-08-18&period=week");
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByRole("button", { name: "Week", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page).toHaveURL(/week=2026-08-25/);
  await expect(page).toHaveURL(/period=week/);

  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page).not.toHaveURL(/period=/);
  await expect(page).toHaveURL(/week=2026-08-25/);
});
