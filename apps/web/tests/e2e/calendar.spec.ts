import { expect, test } from "@playwright/test";

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
  await expect(page.getByRole("button", { name: "Meals" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tasks" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expenses" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Projects" })).toBeVisible();

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

  await page.getByRole("button", { name: "Meals" }).last().click();
  const mealDialog = page.getByRole("dialog", { name: "New Meal" });
  await expect(mealDialog).toBeVisible();
  await expect(
    mealDialog.getByRole("button", { name: "Date", exact: true }),
  ).toContainText("Jul 14, 2026");
  expect(pageErrors).toEqual([]);
});
