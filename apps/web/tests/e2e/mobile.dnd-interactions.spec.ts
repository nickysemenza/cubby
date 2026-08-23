import { dragByTouch, waitForDndMutation } from "./dnd-helpers";
import { seedTaskPrerequisite } from "./e2e-fixtures";
import { expect, test } from "./e2e-test";

test("long-press moves a task in the responsive agenda and persists it", async ({
  page,
}, testInfo) => {
  const name = `e2e touch drag task ${Date.now()}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await seedTaskPrerequisite(page, { name });
  await page.goto(`/tasks?view=board&q=${encodeURIComponent(name)}`);

  const destination = page.getByRole("group", {
    name: "In progress task drop target",
  });
  await expect(page.getByRole("button", { name: `Drag ${name}` })).toBeVisible({
    timeout: 15_000,
  });
  const committed = waitForDndMutation(page, "task.update");
  await dragByTouch(
    page,
    page.getByRole("button", { name: `Drag ${name}` }),
    destination,
  );
  await expect(destination).toContainText(name);

  await committed;
  await page.reload();
  await expect(
    page.getByRole("group", { name: "In progress task drop target" }),
  ).toContainText(name);
  await expect(
    page.getByRole("group", { name: "Not started task drop target" }),
  ).toHaveCount(0);
});
