import { waitForDndMutation } from "./support/dnd-helpers";
import { seedTaskPrerequisite } from "./fixtures/catalog";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("calendar overview opens day events in the record inspector", async ({
  page,
}, testInfo) => {
  const name = `e2e overview task ${testInfo.workerIndex}-${Date.now()}`;
  await seedTaskPrerequisite(page, {
    name,
    due: { start: "2028-02-28", end: "2028-03-03" },
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoAuthenticatedPage(page, "/calendar?date=2028-02-01");
  await expect(
    page.getByRole("button", { name: `${name}, All day` }).first(),
  ).toBeVisible();

  await page.getByRole("combobox", { name: "Calendar period" }).click();
  await page.getByRole("option", { name: "Year", exact: true }).click();
  const grid = page.getByTestId("calendar-overview");
  await expect(grid).toBeVisible();
  await expect(grid.getByRole("button", { name: /February 29/ })).toBeVisible();
  await grid.getByRole("button", { name: /February 29/ }).click();
  const day = page.getByRole("dialog", { name: /February 29/ });
  await expect(
    day.getByRole("button", { name: new RegExp(name) }),
  ).toBeVisible();
  await day.getByRole("button", { name: new RegExp(name) }).click();
  await expect(day).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: /Task .* preview/ }),
  ).toBeVisible();
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
