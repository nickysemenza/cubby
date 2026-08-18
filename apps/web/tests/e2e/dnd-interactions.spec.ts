import { expect, test } from "@playwright/test";
import { dragByKeyboard, dragByMouse, waitForDndMutation } from "./dnd-helpers";
import { createLocation, createTask } from "./e2e-helpers";

const taskDropTarget = (
  page: Parameters<typeof createTask>[0],
  label: string,
) => page.getByRole("group", { name: `${label} task drop target` });

const calendarDay = (page: Parameters<typeof createTask>[0], label: string) =>
  page.getByRole("gridcell", { name: label, exact: true });

async function expectTaskOnCalendarDay(
  page: Parameters<typeof createTask>[0],
  name: string,
  day: string,
  heading: string,
) {
  await page.goto(`/calendar?date=2026-07-01&day=${day}`);
  await page.waitForLoadState("networkidle");
  const sheet = page.getByRole("dialog", { name: heading });
  await expect(sheet).toContainText(name);
}

async function expectTaskAbsentFromCalendarDay(
  page: Parameters<typeof createTask>[0],
  name: string,
  day: string,
  heading: string,
) {
  await page.goto(`/calendar?date=2026-07-01&day=${day}`);
  await page.waitForLoadState("networkidle");
  const sheet = page.getByRole("dialog", { name: heading });
  await expect(sheet).not.toContainText(name);
}

test.describe("Drag and drop", () => {
  test("moves a task between statuses with the mouse and persists it", async ({
    page,
  }) => {
    const name = `e2e mouse drag task ${Date.now()}`;
    await createTask(page, name);
    await page.goto(`/tasks?view=board&q=${encodeURIComponent(name)}`);
    await page.waitForLoadState("networkidle");

    const source = page.getByRole("button", { name: `Drag ${name}` });
    const destination = taskDropTarget(page, "In progress");
    const committed = waitForDndMutation(page, "task.update");
    await dragByMouse(page, source, destination);
    await expect(destination).toContainText(name);

    await committed;
    await page.reload({ waitUntil: "networkidle" });
    await expect(taskDropTarget(page, "In progress")).toContainText(name);
    await expect(taskDropTarget(page, "Not started")).not.toContainText(name);
  });

  test("moves a task between statuses with the keyboard and persists it", async ({
    page,
  }) => {
    const name = `e2e keyboard drag task ${Date.now()}`;
    await createTask(page, name);
    await page.goto(`/tasks?view=board&q=${encodeURIComponent(name)}`);
    await page.waitForLoadState("networkidle");

    const committed = waitForDndMutation(page, "task.update");
    await dragByKeyboard(page.getByRole("button", { name: `Drag ${name}` }), [
      "ArrowRight",
    ]);
    await expect(taskDropTarget(page, "Later")).toContainText(name);

    await committed;
    await page.reload({ waitUntil: "networkidle" });
    await expect(taskDropTarget(page, "Later")).toContainText(name);
    await expect(taskDropTarget(page, "Not started")).not.toContainText(name);
  });

  test("stages a location in Unknown with the mouse and persists it", async ({
    page,
  }) => {
    const name = `E2E staged location ${Date.now()}`;
    await createLocation(page, name);
    await page.goto("/locations/arrange");
    await page.waitForLoadState("networkidle");

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
    await page.reload({ waitUntil: "networkidle" });
    await expect(
      page.getByRole("group", { name: "Unknown contents drop target" }),
    ).toContainText(name);
  });

  test("rejects dropping a location onto its own child", async ({ page }) => {
    const stamp = Date.now();
    const parentName = `E2E cycle parent ${stamp}`;
    const childName = `E2E cycle child ${stamp}`;
    const parentId = await createLocation(page, parentName);
    await createLocation(page, childName, { parentName });
    await page.goto(`/locations/arrange?at=${parentId}`);

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

    await page.reload({ waitUntil: "networkidle" });
    await expect(
      page.getByRole("region", { name: `${parentName} column` }),
    ).toContainText(childName);
  });

  test("moves a dated task one day with the mouse and persists it", async ({
    page,
  }) => {
    const name = `e2e calendar mouse task ${Date.now()}`;
    await createTask(page, name, { dueDate: "2026-07-14" });
    await page.goto("/calendar?date=2026-07-01");
    await page.waitForLoadState("networkidle");

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
  }) => {
    const name = `e2e calendar keyboard task ${Date.now()}`;
    await createTask(page, name, { dueDate: "2026-07-14" });
    await page.goto("/calendar?date=2026-07-01");
    await page.waitForLoadState("networkidle");

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
