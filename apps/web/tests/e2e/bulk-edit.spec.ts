import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { seedProductPrerequisite } from "./fixtures/catalog";
import { entityApi } from "./support/entity-api";
import { EXPENSE_DATE_REQUIRED_MESSAGE } from "@cubby/schemas/expense-fields";
import type { Page } from "@playwright/test";
import { z } from "zod";

import {
  seedLocationPrerequisite,
  seedPlantPrerequisite,
  seedPlantingPrerequisite,
  seedUnlinkedExpensePrerequisite,
} from "./fixtures/catalog";
import { createEntityFixture, createEntityFixtures } from "./fixtures/core";
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
  const prefix = uniqueName(test.info(), "e2e bulk task");
  const taskNames = [`${prefix} one`, `${prefix} two`];
  const tasks = await createEntityFixtures(
    page,
    "task",
    taskNames.map((name) => ({ name, trade: "other" })),
  );

  // Cold form initialization must not recurse through the combobox store
  // while slower rendering leaves ordinary form updates in flight.
  await gotoAuthenticatedPage(
    page,
    `/tasks?name=${encodeURIComponent(prefix)}`,
  );

  for (const name of taskNames) {
    const row = page.getByRole("row").filter({ hasText: name });
    await row.getByRole("checkbox", { name: "Select row" }).click();
  }

  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  const dialog = page.getByRole("dialog", { name: /^Bulk edit \d+ / });
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

  for (const task of tasks) {
    const updated = await entityApi(page.request).get("task", task.id, {});
    const saved = entityFieldEnvelopeSchemas.task.detail.parse(
      await updated.json(),
    );
    expect(saved.status).toBe("done");
    // The untouched seeded trade verifies that only dirty fields were written.
    expect(fieldValueOf(saved.fields.trade)).toBe("other");
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

  const dialog = page.getByRole("dialog", { name: /^Bulk edit \d+ / });
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
  const saved = entityFieldEnvelopeSchemas.planting.detail.parse(
    await updated.json(),
  );
  expect(fieldValueOf(saved.fields.status)).toBe("finished");
  expect(saved.season).toMatchObject({ start: null, end: "2026-06-01" });
});

async function openBulkEdit(page: Page, rowNames: string[]) {
  for (const name of rowNames) {
    await page
      .getByRole("row")
      .filter({ hasText: name })
      .getByRole("checkbox", { name: "Select row" })
      .check();
  }
  await page
    .locator("[data-bulk-action-bar]")
    .getByRole("button", { name: "Bulk edit...", exact: true })
    .click();
  return page.getByRole("dialog", { name: /^Bulk edit \d+ / });
}

const stockTrackedOut = entityFieldEnvelopeSchemas.product.detail.pick({
  fields: true,
});
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
    return fieldValueOf(
      stockTrackedOut.parse(await response.json()).fields.stockTracked,
    );
  };

  await gotoAuthenticatedPage(page, path);
  let dialog = await openBulkEdit(page, [name]);
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
  dialog = await openBulkEdit(page, [name]);
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

  await gotoAuthenticatedPage(page, path);
  let dialog = await openBulkEdit(page, [cropName]);
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

  dialog = await openBulkEdit(page, [cropName]);
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

  await gotoAuthenticatedPage(
    page,
    `/expenses?q=${encodeURIComponent("e2e bulk")}`,
  );
  const dialog = await openBulkEdit(page, [paidName, freeName]);
  await expect(
    dialog.getByRole("button", { name: "Date unknown", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByText(EXPENSE_DATE_REQUIRED_MESSAGE, { exact: true }),
  ).toBeVisible();
});
