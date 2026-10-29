import { recordSourceTransactionRecordsOut } from "@cubby/schemas/source-transaction-record";
import { eq } from "drizzle-orm";
import { getDb } from "~/server/db/helpers";
import * as schema from "~/server/db/schema";
import { createEvidenceHarnessContext } from "./fixtures/core";
import { gotoAuthenticatedPage, uniqueName } from "./support/e2e-helpers";
import { operationCall } from "./support/operation";

import { expect, test } from "./support/e2e-test";

// Existing booking coverage does not cross the evidence roster, generated detail,
// and judgment editor. Provider facts must survive an ordinary household edit.
test("source evidence uses generic records while provider facts remain immutable", async ({
  page,
}, testInfo) => {
  const description = uniqueName(testInfo, "Synthetic source evidence");
  const { db } = await createEvidenceHarnessContext(page);
  const recorded = await operationCall(
    page.request,
    "sourceTransactionRecord.record",
    {
      import: {
        source: "monarch",
        label: description,
        fingerprint: description,
        dateKind: "posted",
        rowCountDeclared: 1,
      },
      rows: [
        {
          rowPosition: 1,
          accountDescriptor: "Synthetic provider account",
          statementDate: "2026-09-10",
          providerAmount: -12.34,
          rawDescription: description,
        },
      ],
      complete: false,
    },
  );
  expect(recorded.ok(), await recorded.text()).toBe(true);
  const receipt = recordSourceTransactionRecordsOut.parse(recorded.body);
  if (!receipt.batchId) throw new Error("Source evidence collection missing");
  const collection = await getDb(db).query.transactionImport.findFirst({
    where: eq(schema.transactionImport.shortcode, receipt.batchId),
  });
  if (!collection) throw new Error("Retained transaction import missing");
  const evidence = await getDb(db).query.sourceTransactionRecord.findFirst({
    where: eq(schema.sourceTransactionRecord.batchId, collection.id),
  });
  if (!evidence || !collection)
    throw new Error("Retained source evidence missing");

  await gotoAuthenticatedPage(
    page,
    `/source-transaction-records?q=${encodeURIComponent(description)}`,
  );
  await expect(
    page
      .locator(`a[href="/source-transaction-records/${evidence.shortcode}"]`)
      .first(),
  ).toBeVisible();
  await gotoAuthenticatedPage(
    page,
    `/source-transaction-records/${evidence.shortcode}`,
  );
  await page
    .getByRole("button", { name: /Edit Source transaction record/i })
    .click();
  const dialog = page.getByRole("dialog", {
    name: /Edit Source transaction record/i,
  });
  await expect(
    dialog.getByRole("textbox", { name: "Raw description", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Synthetic judgment reviewed against source");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(
    page
      .getByText("Synthetic judgment reviewed against source", { exact: true })
      .first(),
  ).toBeVisible();
  const retained = await getDb(db).query.sourceTransactionRecord.findFirst({
    where: eq(schema.sourceTransactionRecord.id, evidence.id),
  });
  expect(retained).toMatchObject({
    notes: "Synthetic judgment reviewed against source",
    rawDescription: description,
    providerAmount: -12.34,
    batchId: collection.id,
  });

  await gotoAuthenticatedPage(
    page,
    `/transaction-imports?q=${encodeURIComponent(description)}`,
  );
  await expect(
    page
      .locator(`a[href="/transaction-imports/${collection.shortcode}"]`)
      .first(),
  ).toBeVisible();
  await gotoAuthenticatedPage(
    page,
    `/transaction-imports/${collection.shortcode}`,
  );
  await expect(
    page.getByRole("button", { name: /Edit Transaction import/i }),
  ).toHaveCount(0);
  await expect(
    page.getByText(description, { exact: true }).first(),
  ).toBeVisible();
});
