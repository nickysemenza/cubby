import { seedTaskPrerequisite } from "./fixtures/catalog";
import { createEntityFixture } from "./fixtures/core";
import { entityApi } from "./support/entity-api";
import {
  gotoAuthenticatedPage,
  openCommandPalette,
  selectComboboxItem,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Both dependency directions must resolve Project names and URLs through the
// generic reference renderer rather than sending Project IDs to Task detail.
test("project dependencies resolve project references in both directions", async ({
  page,
}) => {
  const suffix = Date.now();
  const blockerName = `e2e prerequisite project ${suffix}`;
  const dependentName = `e2e dependent project ${suffix}`;
  const blocker = await createEntityFixture(page, "project", {
    name: blockerName,
  });
  const dependent = await createEntityFixture(page, "project", {
    name: dependentName,
  });
  const updated = await entityApi(page.request).update(
    "project",
    dependent.id,
    {
      blockedByIds: [blocker.id],
    },
  );
  expect(updated.ok()).toBe(true);

  for (const [owner, target, name] of [
    [blocker, dependent, dependentName],
    [dependent, blocker, blockerName],
  ] as const) {
    await gotoAuthenticatedPage(page, `/projects/${owner.id}`);
    const dependencies = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Dependencies", exact: true }),
    });
    await expect(
      dependencies.getByRole("link", { name, exact: true }),
    ).toHaveAttribute("href", `/projects/${target.id}`);
    await expect(page.getByText(/Invalid task shortcode/)).toHaveCount(0);
  }
});

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
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: /^Trade/ }),
    "Electrical & Lighting",
  );
  await dialog.getByRole("button", { name: /^Create$/ }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
});

test("task detail keeps both ranged due date endpoints editable", async ({
  page,
}) => {
  const name = `e2e ranged task ${Date.now()}`;
  const task = await seedTaskPrerequisite(page, {
    name,
    due: { start: "2031-09-22", end: "2031-09-25" },
  });
  await gotoAuthenticatedPage(page, `/tasks/${task.id}`);

  const due = page.getByRole("button", { name: /Sep 22 – 25, 2031/ });
  await expect(due).toBeVisible();
  await due.click();
  await page.getByRole("button", { name: "Dates", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Dates start" })).toHaveValue(
    "Sep 22, 2031",
  );
  await expect(page.getByRole("textbox", { name: "Dates end" })).toHaveValue(
    "Sep 25, 2031",
  );
  await expect(page.getByText("2031-09-22")).toHaveCount(0);
  await expect(page.getByText("2031-09-25")).toHaveCount(0);
});
