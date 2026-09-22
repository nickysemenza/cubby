import { seedTaskPrerequisite } from "./e2e-fixtures";
import { openCommandPalette, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("command palette search deep-links a task straight to its detail page", async ({
  page,
}) => {
  const name = `e2e palette task ${Date.now()}`;
  const task = await seedTaskPrerequisite(page, { name });
  await gotoAuthenticatedPage(page, "/tasks");

  const palette = await openCommandPalette(page);
  await palette
    .getByPlaceholder("Search or jump to a page…")
    .fill(`tasks:${name}`);
  const resultName = palette
    .locator("div.truncate.text-sm", { hasText: name })
    .first();
  await expect(resultName).toBeVisible();
  await resultName.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
});

test("task quick-add requires a deliberate trade and saves assignment modes", async ({
  page,
}) => {
  const name = `e2e classified task ${Date.now()}`;
  await gotoAuthenticatedPage(page, "/tasks");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await expect(dialog.getByPlaceholder("Select trade")).toBeVisible();
  await dialog.getByPlaceholder("Select trade").click();
  await page
    .getByRole("option", { name: "Electrical & Lighting", exact: true })
    .click();
  await dialog.getByRole("button", { name: /^Create$/ }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
});
