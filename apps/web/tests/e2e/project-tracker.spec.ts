import { seedTaskPrerequisite } from "./fixtures/catalog";
import { createEntityFixture } from "./fixtures/core";
import {
  gotoAuthenticatedPage,
  openCommandPalette,
  selectComboboxItem,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

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

// Maintenance must keep cross-year evidence separate from spending-year filters.
test("maintenance keeps explicit completion history across spending years", async ({
  page,
}) => {
  const suffix = Date.now();
  const project = await createEntityFixture(page, "project", {
    name: `2031 routine maintenance ${suffix}`,
  });
  const name = `Clean synthetic gutters ${suffix}`;
  for (const completedOn of ["2030-01-01", "2030-04-01", "2031-01-01"]) {
    await createEntityFixture(page, "task", {
      trade: "other",
      name,
      projectId: project.id,
      status: "done",
      completedOn,
    });
  }
  const vendor = await createEntityFixture(page, "vendor", {
    name: `Synthetic maintenance supplier ${suffix}`,
  });
  const purchase = await createEntityFixture(page, "purchase", {
    vendorId: vendor.id,
    orderId: `SYNTHETIC-MAINTENANCE-${suffix}`,
  });
  const expenseName = `Synthetic maintenance supply ${suffix}`;
  await createEntityFixture(page, "expense", {
    name: expenseName,
    purchaseId: purchase.id,
    projectId: project.id,
    cost: 12,
    date: "2030-02-01",
    costType: "materials",
    trade: "other",
  });
  await gotoAuthenticatedPage(
    page,
    `/tasks?view=maintenance&maintenanceProjectSearch=${suffix}`,
    page.getByRole("heading", { name: "Observed cadence", exact: true }),
  );
  const cadence = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Observed cadence", exact: true }),
  });
  const row = cadence
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });
  await row.getByRole("button", { name: "3 dated completions" }).click();
  await expect(row).toContainText("3 dated completions");
  await expect(row).toContainText("2 intervals");
  await expect(row).toContainText("Jan 1, 2030");
  await expect(row).toContainText("Apr 1, 2030");
  await expect(row).toContainText("Jan 1, 2031");
  await page.getByLabel("Spending year").fill("");
  await page.getByLabel("Spending year").pressSequentially("2030");
  await expect(page.getByLabel("Spending year")).toHaveValue("2030");
  await page.getByLabel("Spending year").press("Tab");
  await expect(page).toHaveURL(
    (url) =>
      JSON.parse(url.searchParams.get("maintenanceYear") ?? "null") === "2030",
  );
  await expect(row).toContainText("3 dated completions");
  const spending = page.locator("section").filter({
    has: page.getByRole("heading", {
      name: "Purchase spending",
      exact: true,
    }),
  });
  await expect(spending.getByText(expenseName, { exact: true })).toBeVisible();
  await expect(
    spending.getByRole("region", { name: "Spend summary" }),
  ).toContainText("$12.00");
  await page.getByLabel("Spending year").fill("2031");
  await page.getByLabel("Spending year").press("Enter");
  await expect(page).toHaveURL(
    (url) =>
      JSON.parse(url.searchParams.get("maintenanceYear") ?? "null") === "2031",
  );
  await expect(spending.getByText(expenseName, { exact: true })).toHaveCount(0);
  await expect(row).toContainText("3 dated completions");
});
