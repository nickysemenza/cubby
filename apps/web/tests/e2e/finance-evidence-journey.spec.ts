import { recordSourceTransactionRecordsOut } from "@cubby/schemas/source-transaction-record";
import { eq } from "drizzle-orm";
import { getDb } from "~/server/db/helpers";
import * as schema from "~/server/db/schema";
import { createEvidenceHarnessContext } from "./fixtures/core";
import { gotoAuthenticatedPage, uniqueName } from "./support/e2e-helpers";
import { startOperation } from "./support/start-operation";

import { entityApi } from "./support/entity-api";
import { z } from "zod";
import { expect, test } from "./support/e2e-test";

// These corrections cross Expense, settlement allocation and transfer ownership.
// A failure at any boundary must leave the reviewed economic graph intact.
test("moves an early reimbursement and converts reviewed booking atomically", async ({
  page,
  baseURL,
}) => {
  const headers = { Origin: baseURL! };
  const create = async (path: string, data: unknown) => {
    const response = await entityApi(page.request).create(path, data, {
      headers,
    });
    expect(response.status(), await response.text()).toBe(200);
    return z
      .object({ item: z.object({ id: z.string() }) })
      .parse(await response.json()).item.id;
  };
  const post = async (operation: string, data: unknown) => {
    const response = await page.request.post(
      `/api/v1/financialTransaction/${operation}`,
      { headers, data: z.json().parse(data) },
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const categoryId = await create("spendingCategory", {
    name: "Synthetic optional paperwork",
    itemizationExpectation: "not_expected",
    productExpectation: "not_expected",
  });
  const vendorId = await create("vendor", {
    name: "Synthetic event vendor",
    itemizationExpectation: "not_expected",
  });
  const fromPartyId = await create("ledgerParty", {
    name: "Synthetic payer",
    kind: "member",
  });
  const toPartyId = await create("ledgerParty", {
    name: "Synthetic recipient",
    kind: "guest",
  });
  const accountId = await create("financialAccount", {
    name: "Synthetic owned account",
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    ledgerPartyId: fromPartyId,
  });
  const book = async (
    amount: number,
    economicRole: "vendor" | "reimbursement",
  ) => {
    const transactionId = await create("financialTransaction", {
      accountId,
      amount,
      merchant: "Synthetic booked source",
      kind: amount < 0 ? "income" : "purchase",
      status: "posted",
      postedDate: "2026-09-10",
    });
    const review = await post("previewBooking", {
      transactionId,
      vendorId,
      spendingCategoryId: categoryId,
      economicRole,
    });
    const result = z
      .object({ purchaseId: z.string(), expenseId: z.string() })
      .parse(await post("commitBooking", review));
    return { transactionId, ...result };
  };
  const earlyCredit = await book(-40, "reimbursement");
  const original = await book(120, "vendor");
  const attachment = await post("previewBookingCorrection", {
    transactionId: earlyCredit.transactionId,
    action: { kind: "attach_reimbursement", purchaseId: original.purchaseId },
  });
  await post("commitBookingCorrection", attachment);
  const net = await entityApi(page.request).get(
    "purchase",
    original.purchaseId,
    {},
  );
  expect(
    z.object({ expenseTotal: z.number() }).parse(await net.json()).expenseTotal,
  ).toBe(80);
  const move = await book(20, "vendor");
  const transferId = await create("ledgerTransfer", {
    fromPartyId,
    toPartyId,
    amount: 20,
    date: "2026-09-10",
    kind: "internal_move",
  });
  const conversion = await post("previewBookingCorrection", {
    transactionId: move.transactionId,
    action: { kind: "convert_to_transfer", transferId },
  });
  await post("commitBookingCorrection", conversion);
  const converted = await entityApi(page.request).get(
    "financialTransaction",
    move.transactionId,
    {},
  );
  expect(
    z
      .object({
        kind: z.literal("account_transfer"),
        ledgerTransferId: z.string(),
        coverage: z.object({ booking: z.string() }),
      })
      .parse(await converted.json()),
  ).toMatchObject({
    ledgerTransferId: transferId,
    coverage: { booking: "not_applicable" },
  });
  const retired = await entityApi(page.request).get(
    "expense",
    move.expenseId,
    {},
  );
  expect(retired.status()).toBe(404);
  const edited = await book(25, "vendor");
  const editedTransferId = await create("ledgerTransfer", {
    fromPartyId,
    toPartyId,
    amount: 25,
    date: "2026-09-10",
    kind: "internal_move",
  });
  const stale = await post("previewBookingCorrection", {
    transactionId: edited.transactionId,
    action: { kind: "convert_to_transfer", transferId: editedTransferId },
  });
  const update = await entityApi(page.request).update(
    "expense",
    edited.expenseId,
    { notes: "Synthetic reviewed note change" },
    { headers },
  );
  expect(update.ok(), await update.text()).toBeTruthy();
  const rejected = await page.request.post(
    "/api/v1/financialTransaction/commitBookingCorrection",
    { headers, data: stale },
  );
  expect(rejected.ok()).toBeFalsy();
  const retained = await entityApi(page.request).get(
    "expense",
    edited.expenseId,
    {},
  );
  expect(retained.ok(), await retained.text()).toBeTruthy();
});

// Existing booking coverage does not cross the evidence roster, generated detail,
// and judgment editor. Provider facts must survive an ordinary household edit.
test("source evidence uses generic records while provider facts remain immutable", async ({
  page,
}, testInfo) => {
  const description = uniqueName(testInfo, "Synthetic source evidence");
  const { db } = await createEvidenceHarnessContext(page);
  const recorded = await startOperation(
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
