import { dragByTouch, waitForDndMutation } from "./dnd-helpers";
import { seedTaskPrerequisite } from "./e2e-fixtures";
import { gotoAuthenticatedPage, reloadAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("long-press moves a task in the responsive agenda and persists it", async ({
  page,
}, testInfo) => {
  const name = `e2e touch drag task ${Date.now()}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await seedTaskPrerequisite(page, { name });
  const destination = page.getByRole("group", {
    name: "In progress task drop target",
  });
  const source = page.getByRole("button", { name: `Drag ${name}` });
  await gotoAuthenticatedPage(
    page,
    `/tasks?view=board&q=${encodeURIComponent(name)}`,
    source,
  );
  const committed = waitForDndMutation(page, "task", "task.board");
  await dragByTouch(page, source, destination);
  await expect(destination).toContainText(name);

  await committed;
  const persistedDestination = page.getByRole("group", {
    name: "In progress task drop target",
  });
  await reloadAuthenticatedPage(page, persistedDestination);
  await expect(persistedDestination).toContainText(name);
  await expect(
    page.getByRole("group", { name: "Not started task drop target" }),
  ).toHaveCount(0);
});
