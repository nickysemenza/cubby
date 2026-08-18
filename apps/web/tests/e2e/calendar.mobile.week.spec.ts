import { expect, test } from "@playwright/test";

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
