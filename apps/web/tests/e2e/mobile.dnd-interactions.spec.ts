import { expect, test } from "@playwright/test";
import { dragByTouch, waitForDndMutation } from "./dnd-helpers";
import { createTask } from "./e2e-helpers";

test("long-press moves a task in the responsive agenda and persists it", async ({
  page,
}) => {
  const name = `e2e touch drag task ${Date.now()}`;
  await createTask(page, name);
  await page.goto(`/tasks?view=board&q=${encodeURIComponent(name)}`);
  await page.waitForLoadState("networkidle");

  const destination = page.getByRole("group", {
    name: "In progress task drop target",
  });
  const committed = waitForDndMutation(page, "task.update");
  await dragByTouch(
    page,
    page.getByRole("button", { name: `Drag ${name}` }),
    destination,
  );
  await expect(destination).toContainText(name);

  await committed;
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("group", { name: "In progress task drop target" }),
  ).toContainText(name);
  await expect(
    page.getByRole("group", { name: "Not started task drop target" }),
  ).toHaveCount(0);
});
