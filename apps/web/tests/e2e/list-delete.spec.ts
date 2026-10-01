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

  await confirm.click();
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
