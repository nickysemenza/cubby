import type { PgTable } from "drizzle-orm/pg-core";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { recordSourceTransactionRecordsOut } from "@cubby/schemas/source-transaction-record";
import { eq } from "drizzle-orm";
import { getDb } from "~/server/db/helpers";
import * as schema from "~/server/db/schema";
import { createEvidenceHarnessContext } from "./fixtures/core";
import { dispatchesOperation } from "./support/dispatch-wire";
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
  const batchId = receipt.batchId;
  if (!batchId) throw new Error("Source evidence collection missing");
  const collection = await getDb(db).query.transactionImport.findFirst({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(table, eq(schema.transactionImport.shortcode, batchId)),
    },
  });
  if (!collection) throw new Error("Retained transaction import missing");
  const evidence = await getDb(db).query.sourceTransactionRecord.findFirst({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          eq(schema.sourceTransactionRecord.batchId, collection.id),
        ),
    },
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
  // The dialog closes while the save is in flight. A reload before the commit
  // server-renders the old value, and the client does not refetch it.
  await Promise.all([
    page.waitForResponse((response) =>
      dispatchesOperation(response.request(), "entity.mutate"),
    ),
    dialog.getByRole("button", { name: "Save changes", exact: true }).click(),
  ]);
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(
    page
      .getByText("Synthetic judgment reviewed against source", { exact: true })
      .first(),
  ).toBeVisible();
  const retained = await getDb(db).query.sourceTransactionRecord.findFirst({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          eq(schema.sourceTransactionRecord.id, evidence.id),
        ),
    },
  });
  expect(retained).toMatchObject({
    rawDescription: description,
    providerAmount: -1234n,
    batchId: collection.id,
  });

  const annotation = await getDb(
    db,
  ).query.sourceObservationAnnotation.findFirst({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          eq(schema.sourceObservationAnnotation.observationId, evidence.id),
        ),
    },
  });
  expect(annotation?.notes).toBe("Synthetic judgment reviewed against source");

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
