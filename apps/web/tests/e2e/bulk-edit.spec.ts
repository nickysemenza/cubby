import { seedProductPrerequisite } from "./fixtures/catalog";
import { entityApi } from "./support/entity-api";
import { EXPENSE_DATE_REQUIRED_MESSAGE } from "@cubby/schemas/expense-fields";
import type { Page } from "@playwright/test";
import { z } from "zod";

import {
  seedLocationPrerequisite,
  seedPlantPrerequisite,
  seedPlantingPrerequisite,
  seedTaskPrerequisite,
  seedUnlinkedExpensePrerequisite,
} from "./fixtures/catalog";
import { createEntityFixture, createEntityFixtures } from "./fixtures/core";
import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import {
  dispatchesOperation,
  operationResult,
  unbatchFor,
} from "./support/dispatch-wire";
import { gotoAuthenticatedPage, uniqueName } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

/**
 * The generic `bulkEdit` action (`bulk-edit-entity-action.tsx`): a list's
 * multi-select bar opens one dialog driven by the derived bulk update roster,
 * and the write touches only the fields the dialog's form was dirtied on —
 * every unselected task/planting keeps its other seeded values. The later
 * cases pin the assignment distinctions the dialog must keep: an explicit
 * false versus an untouched checkbox, a nullable reference set and cleared,
 * and the expense date rule refusing "Date unknown" for a paid row.
 */

test("task board multi-select bulk-edits status without touching other fields", async ({
  page,
}) => {
  const suffix = Date.now();
  const taskOneName = `e2e bulk task one ${suffix}`;
  const taskTwoName = `e2e bulk task two ${suffix}`;
  const taskOne = await seedTaskPrerequisite(page, { name: taskOneName });
  const taskTwo = await seedTaskPrerequisite(page, { name: taskTwoName });

  // Cold form initialization must not recurse through the combobox store
  // while slower rendering leaves ordinary form updates in flight.
  await gotoAuthenticatedPage(page, "/tasks");

  for (const name of [taskOneName, taskTwoName]) {
    const row = page.getByRole("row").filter({ hasText: name });
    await row.getByRole("checkbox", { name: "Select row" }).click();
  }

  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  const dialog = page.getByRole("dialog");
  try {
    await page
      .locator("[data-bulk-action-bar]")
      .getByRole("button", { name: "Bulk edit...", exact: true })
      .click();
    await dialog.getByRole("combobox", { name: "Status", exact: true }).click();
    await page.getByRole("option", { name: "Done", exact: true }).click();
  } finally {
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await session.detach();
  }

  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  for (const task of [taskOne, taskTwo]) {
    const updated = await entityApi(page.request).get("task", task.id, {});
    expect(await updated.json()).toMatchObject({
      status: "done",
      // Seeded as "other" and never touched in the dialog — proves the
      // write was the dirty-field subset, not the whole form.
      trade: "other",
    });
  }
});

// Cross one page boundary with the smallest cohort: the write must include
// the unloaded record and preserve the filter scope without hydrating it.
test("all matching selection bulk-edits unloaded tasks within the active scope", async ({
  page,
}) => {
  test.slow();
  const prefix = uniqueName(test.info(), "Complete matching tasks");
  const pageSize = 1;
  const count = pageSize + 1;
  const selected = await createEntityFixtures(
    page,
    "task",
    Array.from({ length: count }, (_, index) => ({
      name: `${prefix} ${index}`,
      status: "in_progress",
      trade: "other",
    })),
  );
  const outside = await seedTaskPrerequisite(page, {
    name: uniqueName(test.info(), "Outside matching scope"),
    status: "in_progress",
  });
  let releaseNextPage = () => {};
  const nextPage = new Promise<void>((resolve) => {
    releaseNextPage = resolve;
  });
  const pageInput = z.object({
    pagination: z.object({ pageIndex: z.number() }),
  });
  // Keep the final record unloaded until action admission has resolved it;
  // the ordinary sentinel may prefetch while selection changes the layout.
  await page.route(`**${BROWSER_OPERATION_PATH}/**`, async (route) => {
    if (await unbatchFor(route, ["entity.listBase"])) return;
    if (
      dispatchesOperation(
        route.request(),
        "entity.listBase",
        ({ input }) => pageInput.parse(input).pagination.pageIndex > 0,
      )
    )
      await nextPage;
    await route.continue();
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAuthenticatedPage(
      page,
      `/tasks?name=${encodeURIComponent(prefix)}&pageSize=${pageSize}`,
    );
    await expect(
      page
        .getByRole("table")
        .getByRole("row")
        .filter({ hasText: prefix })
        .first(),
    ).toBeVisible();
    await expect(
      page.getByRole("table").getByRole("row").filter({ hasText: prefix }),
    ).toHaveCount(pageSize);
    await page
      .getByRole("table")
      .getByRole("checkbox", { name: "Select all", exact: true })
      .check();
    const bar = page.locator("[data-bulk-action-bar]");
    await expect(bar).toContainText(`${pageSize} selected`);
    await bar
      .getByRole("button", { name: `Select all ${count}`, exact: true })
      .click();
    await expect(bar).toContainText(`${count} selected`);
    await bar
      .getByRole("button", { name: "Bulk edit...", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    releaseNextPage();
    await dialog.getByRole("combobox", { name: "Status", exact: true }).click();
    await page.getByRole("option", { name: "Done", exact: true }).click();
    const saved = page.waitForResponse(
      (response) => dispatchesOperation(response.request(), "entity.mutate"),
      { timeout: 30000 },
    );
    await dialog.getByRole("button", { name: "Update", exact: true }).click();
    await operationResult(await saved, "entity.mutate", z.unknown());
    await expect(dialog).not.toBeVisible();
    const response = await entityApi(page.request).list("task", {
      filters: { ids: selected.map(({ id }) => id) },
      pagination: { pageIndex: 0, pageSize: count },
    });
    expect(response.status()).toBe(200);
    const result = z
      .object({
        items: z.array(z.object({ id: z.string(), status: z.string() })),
      })
      .parse(await response.json());
    expect(result.items).toHaveLength(count);
    expect(result.items.every(({ status }) => status === "done")).toBe(true);
    expect(
      await (await entityApi(page.request).get("task", outside.id)).json(),
    ).toMatchObject({ status: "in_progress" });
  } finally {
    releaseNextPage();
  }
});

test("plantings list bulk-edits status finished plus a date in one write", async ({
  page,
}) => {
  const suffix = Date.now();
  const cropName = `e2e bulk crop ${suffix}`;
  const otherCropName = `e2e unrelated crop ${suffix}`;
  const crop = await seedPlantPrerequisite(page, cropName);
  const otherCrop = await seedPlantPrerequisite(page, otherCropName);
  const planting = await seedPlantingPrerequisite(page, {
    plantId: crop.id,
  });
  await seedPlantingPrerequisite(page, { plantId: otherCrop.id });

  await gotoAuthenticatedPage(page, `/plantings?plantId=${crop.id}`);

  await expect(
    page.getByRole("button", { name: `Plant: ${cropName}`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: otherCropName }),
  ).toHaveCount(0);

  await page
    .getByRole("row")
    .filter({ hasText: cropName })
    .getByRole("checkbox", { name: "Select row" })
    .click();

  await page
    .locator("[data-bulk-action-bar]")
    .getByRole("button", { name: "Bulk edit...", exact: true })
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Bulk edit 1 Planting?")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Update", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByText(/cannot proceed/iu)).toHaveCount(0);

  await dialog.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "Finished", exact: true }).click();
  await dialog
    .getByRole("group", { name: "Season change" })
    .getByRole("button", { name: "Set value" })
    .click();
  await dialog.getByRole("button", { name: "Season", exact: true }).click();
  const seasonEnd = page.getByRole("textbox", { name: "Season end" });
  await seasonEnd.fill("Jun 1, 2026");
  await seasonEnd.press("Enter");
  await page.getByRole("button", { name: "Done", exact: true }).click();

  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  const updated = await entityApi(page.request).get(
    "planting",
    planting.id,
    {},
  );
  expect(await updated.json()).toMatchObject({
    status: "finished",
    season: { start: null, end: "2026-06-01" },
  });
});

async function openBulkEdit(page: Page, path: string, rowNames: string[]) {
  await gotoAuthenticatedPage(page, path);
  for (const name of rowNames) {
    await page
      .getByRole("row")
      .filter({ hasText: name })
      .getByRole("checkbox", { name: "Select row" })
      .click();
  }
  await page
    .locator("[data-bulk-action-bar]")
    .getByRole("button", { name: "Bulk edit...", exact: true })
    .click();
  return page.getByRole("dialog");
}

const stockTrackedOut = z.object({ stockTracked: z.boolean().nullable() });
const locationOut = z.object({ locationId: z.string().nullable() });

test("an unchecked checkbox writes false, while leaving it unchanged writes nothing", async ({
  page,
}) => {
  const name = uniqueName(test.info(), "e2e bulk tracked product");
  const product = await seedProductPrerequisite(page, {
    name,
    brandName: "E2E fixture",
    tags: [],
    stockTracked: true,
  });
  const path = `/products?searchQuery=${encodeURIComponent(name)}`;
  const readStockTracked = async () => {
    const response = await entityApi(page.request).get(
      "product",
      product.id,
      {},
    );
    return stockTrackedOut.parse(await response.json()).stockTracked;
  };

  let dialog = await openBulkEdit(page, path, [name]);
  const tracked = dialog.getByRole("checkbox", {
    name: "Stock tracked",
    exact: true,
  });
  const update = dialog.getByRole("button", { name: "Update", exact: true });
  await expect(update).toBeDisabled();
  // Touched and returned to unchecked: unchecked is an explicit false.
  await tracked.click();
  await tracked.click();
  await expect(tracked).not.toBeChecked();
  await expect(update).toBeEnabled();
  await update.click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(readStockTracked).toBe(false);

  // A dirtied value, then "Leave unchanged", returns the dialog to pristine.
  dialog = await openBulkEdit(page, path, [name]);
  const modes = dialog.getByRole("group", { name: "Stock tracked change" });
  await modes.getByRole("button", { name: "Set value", exact: true }).click();
  await tracked.click();
  await expect(tracked).toBeChecked();
  await expect(update).toBeEnabled();
  await modes
    .getByRole("button", { name: "Leave unchanged", exact: true })
    .click();
  await expect(update).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect.poll(readStockTracked).toBe(false);
});

test("a nullable reference is set through its picker and then cleared", async ({
  page,
}) => {
  const cropName = uniqueName(test.info(), "e2e bulk reference crop");
  const bedName = uniqueName(test.info(), "e2e bulk reference bed");
  const crop = await seedPlantPrerequisite(page, cropName);
  const bed = await seedLocationPrerequisite(page, bedName);
  const planting = await seedPlantingPrerequisite(page, { plantId: crop.id });
  const path = `/plantings?plantId=${crop.id}`;
  const readLocation = async () => {
    const response = await entityApi(page.request).get(
      "planting",
      planting.id,
      {},
    );
    return locationOut.parse(await response.json()).locationId;
  };

  let dialog = await openBulkEdit(page, path, [cropName]);
  const picker = dialog.getByRole("combobox", {
    name: "Location",
    exact: true,
  });
  await picker.click();
  await picker.fill(bedName);
  await page.getByRole("option", { name: bedName }).click();
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(readLocation).toBe(bed.id);

  dialog = await openBulkEdit(page, path, [cropName]);
  await dialog
    .getByRole("group", { name: "Location change" })
    .getByRole("button", { name: "Clear", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(readLocation).toBeNull();
});

test("a selection holding a paid expense refuses to clear the date", async ({
  page,
}) => {
  const paidName = uniqueName(test.info(), "e2e bulk paid expense");
  const freeName = uniqueName(test.info(), "e2e bulk free expense");
  await seedUnlinkedExpensePrerequisite(page, paidName);
  await createEntityFixture(page, "expense", {
    name: freeName,
    cost: 0,
    date: "2026-01-05",
    costType: "materials",
    trade: "other",
    lineKind: "principal",
    lineBasis: "item_line",
  });

  const dialog = await openBulkEdit(
    page,
    `/expenses?q=${encodeURIComponent("e2e bulk")}`,
    [paidName, freeName],
  );
  await expect(
    dialog.getByRole("button", { name: "Date unknown", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByText(EXPENSE_DATE_REQUIRED_MESSAGE, { exact: true }),
  ).toBeVisible();
});
