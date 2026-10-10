import type { Request } from "@playwright/test";
import { z } from "zod";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { dispatchesOperation } from "./dispatch-wire";
import { seedTaskPrerequisite } from "./fixtures-catalog";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

/**
 * List/selection delete confirms through the same dialog as the detail
 * action: the rows about to go plus the advisory connection-impact preview,
 * then the optimistic removal from the list.
 */

test("task list selection delete shows the impact preview, then removes the rows", async ({
  page,
}) => {
  const suffix = Date.now();
  const names = [
    `e2e delete task one ${suffix}`,
    `e2e delete task two ${suffix}`,
  ];
  const tasks = [
    await seedTaskPrerequisite(page, { name: names[0]! }),
    await seedTaskPrerequisite(page, { name: names[1]! }),
  ];

  // Replaying a selection updater after optimistic removal must not crash.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  await gotoAuthenticatedPage(page, "/tasks");
  for (const name of names) {
    await page
      .getByRole("row")
      .filter({ hasText: name })
      .getByRole("checkbox", { name: "Select row" })
      .click();
  }

  await page
    .locator("[data-bulk-action-bar]")
    .getByRole("button", { name: "Delete", exact: true })
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Delete 2 Tasks?")).toBeVisible();
  for (const name of names) await expect(dialog.getByText(name)).toBeVisible();
  // Advisory only: rendered once the connections query settles, and never
  // gates the confirm button.
  await expect(dialog.getByText(/preview is advisory/iu)).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Delete", exact: true });
  await expect(confirm).toBeEnabled();

  const commandSchema = z.object({
    entity: z.literal("task"),
    action: z.literal("delete"),
    ids: z.array(z.string()),
  });
  const isDelete = (request: Request) =>
    dispatchesOperation(request, "entity.mutate", ({ input }) => {
      const command = commandSchema.safeParse(input);
      return (
        command.success &&
        command.data.ids.length === tasks.length &&
        tasks.every((task) => command.data.ids.includes(task.id))
      );
    });
  let releaseDelete = () => {};
  const held = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let intercepted = false;
  await page.route(`**${BROWSER_OPERATION_PATH}`, async (route) => {
    if (!isDelete(route.request())) {
      await route.continue();
      return;
    }
    intercepted = true;
    await held;
    await route.continue();
  });
  const deleted = page.waitForResponse((response) =>
    isDelete(response.request()),
  );
  try {
    await confirm.click();
    await expect.poll(() => intercepted).toBe(true);
    await expect(
      dialog.getByRole("button", { name: "Deleting...", exact: true }),
    ).toBeDisabled();
    for (const task of tasks) {
      const existing = await page.request.get(`/api/v1/tasks/${task.id}`);
      expect(existing.status()).toBe(200);
      expect(await existing.json()).toMatchObject({ id: task.id });
    }
  } finally {
    releaseDelete();
  }
  expect((await deleted).ok()).toBe(true);
  await expect(dialog).not.toBeVisible();

  for (const name of names) {
    await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(
      0,
    );
  }
  for (const task of tasks) {
    const gone = await page.request.get(`/api/v1/tasks/${task.id}`);
    expect(gone.status()).toBe(404);
  }
});
