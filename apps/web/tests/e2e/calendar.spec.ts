import { waitForDndMutation } from "./support/dnd-helpers";
import { seedTaskPrerequisite } from "./fixtures/catalog";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { dispatchesOperation } from "./support/dispatch-wire";

test("long calendar views fit the workspace and open day events in the record inspector", async ({
  page,
}, testInfo) => {
  const name = `e2e overview task ${testInfo.workerIndex}-${Date.now()}`;
  await seedTaskPrerequisite(page, {
    name,
    due: { start: "2028-02-28", end: "2028-03-03" },
  });
  for (const label of ["Check supplies", "Plan planting", "Book service"]) {
    await seedTaskPrerequisite(page, {
      name: `${label} ${testInfo.workerIndex}`,
      due: { start: "2028-02-29", end: null },
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoAuthenticatedPage(page, "/calendar?date=2028-02-01");
  await expect(
    page.getByRole("button", { name: `${name}, All day` }).first(),
  ).toBeVisible();

  const pending = Promise.withResolvers<void>();
  await page.route("**/api/operations/*", async (route) => {
    if (dispatchesOperation(route.request(), "calendar.range"))
      await pending.promise;
    await route.continue();
  });
  await page.getByRole("combobox", { name: "Calendar period" }).click();
  await page.getByRole("option", { name: "Year", exact: true }).click();
  try {
    await expect(
      page.getByRole("status").filter({ hasText: "Loading calendar…" }),
    ).toBeVisible();
    await expect(
      page.getByText("No events in this period.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `${name}, All day` }),
    ).toHaveCount(0);
  } finally {
    pending.resolve();
  }
  const grid = page.getByTestId("calendar-overview");
  await expect(grid).toBeVisible();
  await expect(grid.getByRole("button", { name: /February 29/ })).toBeVisible();
  const bounds = await grid.boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(1000);
  const alignedColumns = Number(await grid.getAttribute("data-columns"));
  expect(alignedColumns % 7).toBe(0);
  await expect(grid.getByText(name, { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("calendar-year.png") });
  await page.getByRole("switch", { name: "Align weekdays" }).click();
  await expect(
    page.getByRole("switch", { name: "Align weekdays" }),
  ).not.toBeChecked();
  await page.getByRole("combobox", { name: "Calendar period" }).click();
  await page.getByRole("option", { name: "6 months", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Jan–Jun 2028" }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Align weekdays" }),
  ).not.toBeChecked();
  await grid.getByRole("button", { name: /February 29/ }).click();
  const day = page.getByRole("dialog", { name: /February 29/ });
  await expect(
    day.getByRole("button", { name: new RegExp(name) }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("calendar-overview.png") });
  await day.getByRole("button", { name: new RegExp(name) }).click();
  await expect(day).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: /Task .* preview/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Calendar period" }).click();
  await page.getByRole("option", { name: "Year", exact: true }).click();
  await page.getByRole("switch", { name: "Align weekdays" }).click();
  await page.setViewportSize({ width: 768, height: 768 });
  const leapDay = grid.getByRole("button", { name: /February 29/ });
  await expect(leapDay).toBeVisible();
  await expect(leapDay.getByText("+4", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("calendar-year-narrow.png"),
  });
  await leapDay.click();
  await expect(
    page.getByRole("dialog", { name: /February 29/ }).getByRole("button"),
  ).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(leapDay).toBeFocused();
});

test("calendar events open an anchored editor, save atomically, and restore focus", async ({
  page,
}, testInfo) => {
  const name = `e2e inline calendar task ${Date.now()}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const updatedName = `${name} edited`;
  await seedTaskPrerequisite(page, {
    name,
    due: { start: "2026-07-16", end: null },
  });
  await gotoAuthenticatedPage(page, "/calendar?date=2026-07-01");

  const event = page.getByRole("button", { name: `${name}, All day` }).first();
  await event.click();
  const editor = page.getByRole("dialog", { name });
  await editor.getByLabel("Name").fill(updatedName);
  const committed = waitForDndMutation(page, "task");
  await editor.getByRole("button", { name: "Save" }).click();
  await committed;
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const updatedEvent = page
    .getByRole("button", { name: `${updatedName}, All day` })
    .first();
  await updatedEvent.click();
  await page.keyboard.press("Escape");
  await expect(updatedEvent).toBeFocused();
});
