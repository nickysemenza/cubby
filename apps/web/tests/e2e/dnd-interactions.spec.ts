import type { Page, TestInfo } from "@playwright/test";
import { dragByKeyboard, waitForDndMutation } from "./support/dnd-helpers";
import { seedTaskPrerequisite } from "./fixtures/catalog";
import {
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

const fixtureName = (prefix: string, testInfo: TestInfo) =>
  `${prefix} ${Date.now()}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;

const taskDropTarget = (page: Page, label: string) =>
  page.getByRole("region", { name: label, exact: true });

test("moves a task between statuses with the keyboard and persists it", async ({
  page,
}, testInfo) => {
  const name = fixtureName("e2e keyboard drag task", testInfo);
  await seedTaskPrerequisite(page, { name });

  const source = page.getByRole("button", { name: `Drag ${name}` });
  await gotoAuthenticatedPage(
    page,
    `/tasks?view=board&searchQuery=${encodeURIComponent(name)}`,
    source,
  );
  const committed = waitForDndMutation(page, "task", "entity.list");
  await dragByKeyboard(source, ["ArrowRight"]);
  await committed;
  await reloadAuthenticatedPage(page, taskDropTarget(page, "Later"));
  await expect(taskDropTarget(page, "Later")).toContainText(name);
  await expect(taskDropTarget(page, "Not started")).not.toContainText(name);
});
