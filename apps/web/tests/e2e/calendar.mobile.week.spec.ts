import { expect, test } from "@playwright/test";
import { waitForDndMutation } from "./dnd-helpers";
import { seedTaskPrerequisite } from "./e2e-fixtures";

test("weekly planning becomes a seven-day ruled agenda without overflow", async ({
  page,
}) => {
  await page.goto("/calendar?date=2026-08-18&period=week");

  await expect(
    page.getByRole("button", { name: "Week", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const agenda = page.locator('[data-slot="calendar-agenda"]');
  await expect(agenda).toBeVisible();
  await expect(agenda.locator("section")).toHaveCount(7);
  await expect(
    page.locator('[data-slot="event-calendar-week-view"]'),
  ).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await agenda
    .locator('section[data-day="2026-08-18"]')
    .getByRole("button", { name: /^Tue Aug 18\b/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Tuesday, August 18" }),
  ).toBeVisible();
});

test("phone agenda events edit in a bottom sheet", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const name = `e2e phone calendar task ${stamp}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const updatedName = `${name} edited`;
  await seedTaskPrerequisite(page, { name, dueDate: "2026-08-18" });
  await page.goto("/calendar?date=2026-08-18&period=week");

  const agenda = page.locator('[data-slot="calendar-agenda"]');
  await agenda.getByRole("button", { name: new RegExp(name) }).click();
  const editor = page.getByRole("dialog", { name });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("data-side", "bottom");
  await editor.getByLabel("Name").fill(updatedName);
  const committed = waitForDndMutation(page, "task.update");
  await editor.getByRole("button", { name: "Save" }).click();
  await committed;
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(agenda.getByText(updatedName)).toBeVisible();
});
