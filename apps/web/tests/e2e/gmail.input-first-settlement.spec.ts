import { performOperation } from "./support/dispatch-wire";
import { recordSourceTransactionRecordsOut } from "@cubby/schemas/source-transaction-record";
import { startOperation } from "./support/start-operation";
import { entityApi } from "./support/entity-api";
import { and, eq, inArray } from "drizzle-orm";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import * as schema from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { setMemberLoginParty } from "~/server/http/member-login";
import {
  convergenceNames,
  createConvergenceFixtures,
  importBrowserOrder,
  sha256Hex,
  syntheticOrderIds,
} from "../../tooling/convergence-harness";
import {
  createFixtureGraph,
  createEvidenceHarnessContext,
  ensureMemberParty,
} from "./fixtures/core";
import { gotoDetailActions, openDetailActions } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Signed refund/group allocations must conserve actual statement activity without
// auto-booking Expense, duplicating retries, or creating owned Inventory.
test("reviews statement charge groups and refunds against captured retailer orders", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const token = `settlement-${Date.now()}`;
  const names = convergenceNames(token);
  const { db, actor } = await createEvidenceHarnessContext(page);
  const database = getDb(db);
  const member = await ensureMemberParty(page, names.name);
  await setMemberLoginParty(
    db,
    actor.userId,
    parseShortcodeFor("ledgerParty", member.shortcode),
    actor,
  );
  const prerequisites = await createFixtureGraph(page, (create) =>
    createConvergenceFixtures(create, member.shortcode, names),
  );
  const vendorId = await resolveOrThrow(db, "vendor", prerequisites.vendor.id);
  const cardId = await resolveOrThrow(
    db,
    "financialAccount",
    prerequisites.card.id,
  );
  const descriptions = {
    charge: `SYNTHETIC GROUP ${token}`,
    refund: `SYNTHETIC REFUND ${token}`,
    held: `SYNTHETIC CARD PAYMENT ${token}`,
  };
  const statementInput = {
    import: {
      source: "monarch",
      label: `Synthetic settlement ${token}`,
      fingerprint: token,
      dateKind: "posted",
    },
    rows: [
      {
        providerTransactionId: `${token}-charge`,
        accountDescriptor: names.statementAccount,
        statementDate: "2026-09-12",
        providerAmount: -85,
        merchant: names.name,
        rawDescription: descriptions.charge,
        sourceCategory: "Clothing",
      },
      {
        providerTransactionId: `${token}-refund`,
        accountDescriptor: names.statementAccount,
        statementDate: "2026-09-14",
        providerAmount: 15,
        merchant: names.name,
        rawDescription: descriptions.refund,
        sourceCategory: "Refund",
      },
      {
        providerTransactionId: `${token}-held`,
        accountDescriptor: names.statementAccount,
        statementDate: "2026-09-15",
        providerAmount: 85,
        merchant: "Synthetic Card Payment",
        rawDescription: descriptions.held,
        sourceCategory: "Credit Card Payment",
      },
    ],
    complete: false,
  };
  const expenseCountBefore = (
    await database.query.expense.findMany({ where: notDeleted(schema.expense) })
  ).length;
  const recorded = await startOperation(
    page.request,
    "sourceTransactionRecord.record",
    statementInput,
  );
  expect(recorded.ok(), await recorded.text()).toBe(true);
  const result = recordSourceTransactionRecordsOut.parse(recorded.body);
  expect(result.inserted).toBe(3);
  if (!result.batchId) throw new Error("Recorded statement batch missing");
  const collection = await database.query.transactionImport.findFirst({
    where: eq(schema.transactionImport.shortcode, result.batchId),
  });
  if (!collection) throw new Error("Retained transaction import missing");
  expect(
    await database.query.financialTransaction.findMany({
      where: eq(schema.financialTransaction.accountId, cardId),
    }),
  ).toHaveLength(0);
  // These fixture decisions explicitly approve two kinds; the payment remains evidence only.
  for (const decision of [
    { description: descriptions.charge, kind: "purchase" },
    { description: descriptions.refund, kind: "refund" },
  ] as const) {
    const evidence = await database.query.sourceTransactionRecord.findFirst({
      where: and(
        eq(schema.sourceTransactionRecord.source, statementInput.import.source),
        eq(schema.sourceTransactionRecord.batchId, collection.id),
        eq(schema.sourceTransactionRecord.rawDescription, decision.description),
        notDeleted(schema.sourceTransactionRecord),
      ),
    });
    if (!evidence) throw new Error("Normalized settlement evidence missing");
    const created = await entityApi(page.request).create(
      "financialTransaction",
      {
        accountId: prerequisites.card.id,
        amount: -evidence.providerAmount,
        merchant: evidence.merchant,
        rawDescription: evidence.rawDescription,
        sourceCategory: evidence.sourceCategory,
        kind: decision.kind,
        status: "posted",
        postedDate: evidence.statementDate,
        sourceRefs: [
          { source: evidence.source, externalId: evidence.externalId },
        ],
      },
    );
    expect(created.ok(), await created.text()).toBe(true);
  }
  const transactions = await database.query.financialTransaction.findMany({
    where: and(
      eq(schema.financialTransaction.accountId, cardId),
      notDeleted(schema.financialTransaction),
    ),
  });
  expect(
    transactions
      .map((row) => ({ kind: row.kind, amount: row.amount }))
      .sort((a, b) => a.amount - b.amount),
  ).toEqual([
    { kind: "refund", amount: -15 },
    { kind: "purchase", amount: 85 },
  ]);
  expect(
    await database.query.expense.findMany({
      where: notDeleted(schema.expense),
    }),
  ).toHaveLength(expenseCountBefore);
  // Captured extraction and browser approval are covered by gmail.input-first-import.
  // Seed the same production prepare/commit writers; this journey owns settlement review.
  const purchaseCodes: string[] = [];
  for (const index of [0, 1]) {
    const orderToken = `${token}-${index}`;
    const orderNames = convergenceNames(orderToken);
    await importBrowserOrder(db, {
      actor,
      vendorId: prerequisites.vendor.id,
      ids: syntheticOrderIds(orderToken),
      externalKey: `synthetic-settlement:${orderToken}`,
      checksum: sha256Hex(orderToken),
      extractionRevision: "synthetic-settlement-v1",
      candidate: { ...orderNames.retailerCandidate, merchant: names.name },
      resolveProduct: async () => undefined,
    });
    const purchase = await database.query.purchase.findFirst({
      where: and(
        eq(schema.purchase.vendorId, vendorId),
        eq(schema.purchase.orderId, orderNames.orderId),
        notDeleted(schema.purchase),
      ),
    });
    if (!purchase) throw new Error("Committed order created no Purchase");
    purchaseCodes.push(purchase.shortcode);
  }
  const purchases = await database.query.purchase.findMany({
    where: and(
      eq(schema.purchase.vendorId, vendorId),
      notDeleted(schema.purchase),
    ),
  });
  expect(purchases).toHaveLength(2);
  const purchaseIds = purchases.map((row) => row.id);
  const expensesBefore = await database.query.expense.findMany({
    where: and(
      inArray(schema.expense.purchaseId, purchaseIds),
      notDeleted(schema.expense),
    ),
  });
  expect(expensesBefore.map((row) => row.cost)).toEqual([42.5, 42.5]);
  const allocationRows = () =>
    database.query.financialTransactionAllocation.findMany({
      where: and(
        inArray(schema.financialTransactionAllocation.purchaseId, purchaseIds),
        notDeleted(schema.financialTransactionAllocation),
      ),
    });
  expect(await allocationRows()).toHaveLength(0);
  const firstCode = purchaseCodes[0]!;
  await gotoDetailActions(
    page,
    `/purchases/${firstCode}#financial-settlement`,
    page.getByRole("button", { name: "Match statement activity", exact: true }),
  );
  await page
    .getByRole("button", { name: "Match statement activity", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Match statement activity",
    exact: true,
  });
  const saveAllocation = async () => {
    // The live allocation check precedes the write; wait for that write before
    // timing the dialog close and its dependent query invalidations.
    await performOperation(
      page,
      "financialTransaction.allocateSettlement",
      () =>
        dialog
          .getByRole("button", { name: "Save allocation", exact: true })
          .click(),
    );
    await expect(dialog).toHaveCount(0);
  };
  await dialog.getByRole("button").filter({ hasText: "$85.00" }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Purchase code 1" }),
  ).toHaveValue(firstCode);
  await dialog
    .getByRole("textbox", { name: "Purchase code 2" })
    .fill(purchaseCodes[1]!);
  await dialog.getByRole("spinbutton", { name: "Amount 2" }).fill("40.00");
  await expect(
    dialog.getByRole("button", { name: "Save allocation", exact: true }),
  ).toBeDisabled();
  expect(await allocationRows()).toHaveLength(0);
  await dialog.getByRole("spinbutton", { name: "Amount 2" }).fill("42.50");
  await saveAllocation();
  expect((await allocationRows()).map((row) => row.amount)).toEqual([
    42.5, 42.5,
  ]);
  const acceptedChargeAllocations = await allocationRows();
  await openDetailActions(page);
  await page
    .getByRole("button", { name: "Match statement activity", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Match statement activity",
    exact: true,
  });
  // An accepted charge stays reviewable for its own Purchase. Opening it must
  // preserve both accepted splits, without redistributing or saving them.
  await dialog.getByRole("button").filter({ hasText: "Charge" }).click();
  expect(
    (
      await Promise.all(
        [1, 2].map((index) =>
          dialog
            .getByRole("textbox", {
              name: `Purchase code ${index}`,
              exact: true,
            })
            .inputValue(),
        ),
      )
    ).sort(),
  ).toEqual([...purchaseCodes].sort());
  for (const index of [1, 2])
    await expect(
      dialog.getByRole("spinbutton", { name: `Amount ${index}`, exact: true }),
    ).toHaveValue("42.50");
  await expect(
    dialog.getByRole("textbox", { name: "Purchase code 3", exact: true }),
  ).toHaveCount(0);
  expect(await allocationRows()).toEqual(acceptedChargeAllocations);
  await dialog.getByRole("button").filter({ hasText: "Refund" }).click();
  await expect(
    dialog.getByRole("spinbutton", { name: "Amount 1" }),
  ).toHaveValue("-15.00");
  await dialog.getByRole("spinbutton", { name: "Amount 1" }).fill("15.00");
  await expect(
    dialog.getByRole("button", { name: "Save allocation", exact: true }),
  ).toBeDisabled();
  expect(await allocationRows()).toEqual(acceptedChargeAllocations);
  await dialog.getByRole("spinbutton", { name: "Amount 1" }).fill("-15.00");
  await saveAllocation();
  expect(
    (await allocationRows()).map((row) => row.amount).sort((a, b) => a - b),
  ).toEqual([-15, 42.5, 42.5]);
  expect(
    await database.query.expense.findMany({
      where: and(
        inArray(schema.expense.purchaseId, purchaseIds),
        notDeleted(schema.expense),
      ),
    }),
  ).toEqual(expensesBefore);
  expect(
    await database.query.inventoryEntry.findMany({
      where: and(
        inArray(
          schema.inventoryEntry.productId,
          expensesBefore.flatMap((row) =>
            row.productId ? [row.productId] : [],
          ),
        ),
        notDeleted(schema.inventoryEntry),
      ),
    }),
  ).toHaveLength(0);
  const replay = await startOperation(
    page.request,
    "sourceTransactionRecord.record",
    statementInput,
  );
  expect(replay.ok(), await replay.text()).toBe(true);
  expect(recordSourceTransactionRecordsOut.parse(replay.body)).toMatchObject({
    inserted: 0,
    alreadyInThisBatch: 3,
  });
  expect(
    await database.query.financialTransaction.findMany({
      where: and(
        eq(schema.financialTransaction.accountId, cardId),
        notDeleted(schema.financialTransaction),
      ),
    }),
  ).toHaveLength(2);
  expect(await allocationRows()).toHaveLength(3);
});
