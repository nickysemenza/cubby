import { waitForDndMutation } from "./dnd-helpers";
import { seedTaskPrerequisite } from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("calendar events open an anchored editor, save atomically, and restore focus", async ({
  page,
}, testInfo) => {
  const name = `e2e inline calendar task ${Date.now()}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const updatedName = `${name} edited`;
  await seedTaskPrerequisite(page, { name, dueDate: "2026-07-16" });
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
