import { seedTaskPrerequisite } from "./e2e-fixtures";
import { openCommandPalette, waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("command palette search deep-links a task straight to its detail page", async ({
  page,
}) => {
  const name = `e2e palette task ${Date.now()}`;
  const task = await seedTaskPrerequisite(page, { name });
  await page.goto("/tasks");
  await waitForAppHydration(page);

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

test("mobile expense quick-add renders as a bottom sheet and still submits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const name = `e2e mobile expense ${Date.now()}`;
  await page.goto("/expenses");
  await waitForAppHydration(page);
  await page.getByRole("button", { name: "New", exact: true }).click();

  const sheet = page.locator('[data-slot="sheet-content"][data-side="bottom"]');
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Name").fill(name);
  await sheet.getByRole("spinbutton", { name: "Cost" }).fill("12.34");
  await sheet.getByPlaceholder("Select cost type").click();
  await page.getByRole("option", { name: "Materials", exact: true }).click();
  await sheet.getByPlaceholder("Select trade").click();
  await page.getByRole("option", { name: "Other", exact: true }).click();
  await sheet.getByRole("button", { name: /^Create$/ }).click();
  await expect(sheet).not.toBeVisible();
  await expect(page.getByText(name).first()).toBeVisible();
});

test("task quick-add requires a deliberate trade and saves assignment modes", async ({
  page,
}) => {
  const name = `e2e classified task ${Date.now()}`;
  await page.goto("/tasks");
  await waitForAppHydration(page);
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
  await expect(page.getByText(name).first()).toBeVisible();
});
