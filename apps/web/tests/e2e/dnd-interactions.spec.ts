import type { Page, TestInfo } from "@playwright/test";
import { dragByKeyboard, dragByMouse, waitForDndMutation } from "./dnd-helpers";
import { seedLocationPrerequisite, seedTaskPrerequisite } from "./e2e-fixtures";
import { selectComboboxItem, waitForFormHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const fixtureName = (prefix: string, testInfo: TestInfo) =>
  `${prefix} ${Date.now()}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;

const taskDropTarget = (page: Page, label: string) =>
  page.getByRole("group", { name: `${label} task drop target` });

const calendarDay = (page: Page, label: string) =>
  page.getByRole("gridcell", { name: label, exact: true });

async function expectTaskOnCalendarDay(
  page: Page,
  name: string,
  day: string,
  heading: string,
) {
  await page.goto(`/calendar?date=2026-07-01&day=${day}`);
  const sheet = page.getByRole("dialog", { name: heading });
  await expect(sheet).toContainText(name);
}

async function expectTaskAbsentFromCalendarDay(
  page: Page,
  name: string,
  day: string,
  heading: string,
) {
  await page.goto(`/calendar?date=2026-07-01&day=${day}`);
  const sheet = page.getByRole("dialog", { name: heading });
  await expect(sheet).not.toContainText(name);
}

test.describe("Drag and drop", () => {
  test("moves a task between statuses with the mouse and persists it", async ({
    page,
  }, testInfo) => {
    const name = fixtureName("e2e mouse drag task", testInfo);
    await seedTaskPrerequisite(page, { name });
    await page.goto(`/tasks?view=board&q=${encodeURIComponent(name)}`);

    const source = page.getByRole("button", { name: `Drag ${name}` });
    await expect(source).toBeVisible({ timeout: 15_000 });
    const destination = taskDropTarget(page, "In progress");
    const committed = waitForDndMutation(page, "task.update");
    await dragByMouse(page, source, destination);
    await expect(destination).toContainText(name);

    await committed;
    await page.reload();
    await expect(taskDropTarget(page, "In progress")).toContainText(name);
    await expect(taskDropTarget(page, "Not started")).not.toContainText(name);
  });

  test("moves a task between statuses with the keyboard and persists it", async ({
    page,
  }, testInfo) => {
    const name = fixtureName("e2e keyboard drag task", testInfo);
    await seedTaskPrerequisite(page, { name });
    await page.goto(`/tasks?view=board&q=${encodeURIComponent(name)}`);

    await expect(
      page.getByRole("button", { name: `Drag ${name}` }),
    ).toBeVisible({ timeout: 15_000 });
    const committed = waitForDndMutation(page, "task.update");
    await dragByKeyboard(page.getByRole("button", { name: `Drag ${name}` }), [
      "ArrowRight",
    ]);
    await expect(taskDropTarget(page, "Later")).toContainText(name);

    await committed;
    await page.reload();
    await expect(taskDropTarget(page, "Later")).toContainText(name);
    await expect(taskDropTarget(page, "Not started")).not.toContainText(name);
  });

  test("stages a location in Unknown with the mouse and persists it", async ({
    page,
  }, testInfo) => {
    const name = fixtureName("E2E staged location", testInfo);
    await seedLocationPrerequisite(page, name);
    await page.goto("/locations/arrange");

    const destination = page.getByRole("group", {
      name: "Unknown contents drop target",
    });
    const committed = waitForDndMutation(page, "location.bulkUpdateParent");
    await dragByMouse(
      page,
      page.getByRole("button", { name: `Drag ${name}` }),
      destination,
    );
    await expect(destination).toContainText(name);

    await committed;
    await page.reload();
    await expect(
      page.getByRole("group", { name: "Unknown contents drop target" }),
    ).toContainText(name);
  });

  test("rejects dropping a location onto its own child", async ({
    page,
  }, testInfo) => {
    const parentName = fixtureName("E2E cycle parent", testInfo);
    const childName = fixtureName("E2E cycle child", testInfo);
    const parent = await seedLocationPrerequisite(page, parentName);
    // Keep the child creation browser-driven: this test owns the parent picker
    // contract as well as the drag rejection.
    await page.goto("/locations/new");
    await waitForFormHydration(page);
    await page.getByPlaceholder("Enter location name").fill(childName);
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /parent location/i }),
      parentName,
    );
    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page).toHaveURL(
      /\/locations\/LOC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/,
      { timeout: 15_000 },
    );
    await page.goto(`/locations/arrange?at=${parent.id}`);

    const parentColumn = page.getByRole("region", {
      name: `${parentName} column`,
    });
    const childTarget = page.getByRole("group", {
      name: `${childName} location drop target`,
    });
    await expect(parentColumn).toContainText(childName);
    await dragByMouse(
      page,
      page.getByRole("button", { name: `Drag ${parentName}` }),
      childTarget,
    );
    await expect(parentColumn).toContainText(childName);

    await page.reload();
    await expect(
      page.getByRole("region", { name: `${parentName} column` }),
    ).toContainText(childName);
  });

  test("moves a dated task one day with the mouse and persists it", async ({
    page,
  }, testInfo) => {
    const name = fixtureName("e2e calendar mouse task", testInfo);
    await seedTaskPrerequisite(page, { name, dueDate: "2026-07-14" });
    await page.goto("/calendar?date=2026-07-01");

    const committed = waitForDndMutation(page, "task.update");
    await dragByMouse(
      page,
      page.getByRole("button", { name: `${name}, All day` }),
      calendarDay(page, "Wednesday, July 15th, 2026"),
    );
    await committed;

    await expectTaskOnCalendarDay(
      page,
      name,
      "2026-07-15",
      "Wednesday, July 15",
    );
    await expectTaskAbsentFromCalendarDay(
      page,
      name,
      "2026-07-14",
      "Tuesday, July 14",
    );
  });

  test("moves a dated task one day with the keyboard and persists it", async ({
    page,
  }, testInfo) => {
    const name = fixtureName("e2e calendar keyboard task", testInfo);
    await seedTaskPrerequisite(page, { name, dueDate: "2026-07-14" });
    await page.goto("/calendar?date=2026-07-01");

    const committed = waitForDndMutation(page, "task.update");
    const source = page.getByRole("button", { name: `${name}, All day` });
    const destination = calendarDay(page, "Wednesday, July 15th, 2026");
    await source.focus();
    await source.press("Space");
    await source.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await source.press("ArrowRight");
    await expect(destination).toHaveAttribute("data-drop-target", "valid");
    await source.press("Space");
    await committed;

    await expectTaskOnCalendarDay(
      page,
      name,
      "2026-07-15",
      "Wednesday, July 15",
    );
    await expectTaskAbsentFromCalendarDay(
      page,
      name,
      "2026-07-14",
      "Tuesday, July 14",
    );
  });
});
