import { waitForDndMutation } from "./dnd-helpers";
import { seedTaskPrerequisite } from "./e2e-fixtures";
import { waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("phone agenda events edit in a bottom sheet", async ({
  page,
}, testInfo) => {
  const name = `e2e phone calendar task ${Date.now()}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const updatedName = `${name} edited`;
  await seedTaskPrerequisite(page, { name, dueDate: "2026-08-18" });
  await page.goto("/calendar?date=2026-08-18&period=week");
  await waitForAppHydration(page);

  const agenda = page.locator('[data-slot="calendar-agenda"]');
  await agenda.getByRole("button", { name: new RegExp(name) }).click();
  const editor = page.getByRole("dialog", { name });
  await expect(editor).toHaveAttribute("data-side", "bottom");
  await editor.getByLabel("Name").fill(updatedName);
  const committed = waitForDndMutation(page, "task");
  await editor.getByRole("button", { name: "Save" }).click();
  await committed;
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(agenda.getByText(updatedName)).toBeVisible();
});
