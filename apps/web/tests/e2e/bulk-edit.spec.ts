import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { entityApi } from "./support/entity-api";

import { createEntityFixtures } from "./fixtures/core";
import {
  gotoAuthenticatedPage,
  uniqueName,
  clickBulkAction,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

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
    await clickBulkAction(page, "Bulk edit...");
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
    const saved = entityFieldEnvelopeSchemas.task.detail
      .pick({ status: true })
      .extend({
        fields: entityFieldEnvelopeSchemas.task.detail.shape.fields.pick({
          trade: true,
        }),
      })
      .parse(await updated.json());
    expect(saved.status).toBe("done");
    // The untouched seeded trade verifies that only dirty fields were written.
    expect(fieldValueOf(saved.fields.trade)).toBe("other");
  }
});
