import { expect, test } from "@playwright/test";
import { waitForDndMutation } from "./dnd-helpers";
import { createTask } from "./e2e-helpers";

test("weekly planning becomes a seven-day ruled agenda without overflow", async ({
  page,
}) => {
  await page.goto("/calendar?date=2026-08-18&period=week");
  await page.waitForLoadState("networkidle");

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
    .getByRole("button")
    .click();
  await expect(
    page.getByRole("heading", { name: "Tuesday, August 18" }),
  ).toBeVisible();
});

test("phone agenda events edit in a bottom sheet", async ({ page }) => {
  const stamp = Date.now();
  const name = `e2e phone calendar task ${stamp}`;
  const updatedName = `e2e phone edited task ${stamp}`;
  await createTask(page, name, { dueDate: "2026-08-18" });
  await page.goto("/calendar?date=2026-08-18&period=week");
  await page.waitForLoadState("networkidle");

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
