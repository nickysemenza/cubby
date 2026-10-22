import { recordStatementRowsOut } from "@cubby/schemas/statement-row";
import { startOperation } from "./support/start-operation";
import { entityApi } from "./support/entity-api";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import * as schema from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { setMemberLoginParty } from "~/server/http/member-login";
import {
  convergenceNames,
  createConvergenceFixtures,
} from "../../tooling/convergence-harness";
import {
  createFixtureGraph,
  createEvidenceHarnessContext,
  ensureMemberParty,
} from "./fixtures/core";
import {
  chooseOption,
  gotoAuthenticatedPage,
  gotoDetailActions,
} from "./support/e2e-helpers";
import { prepareCapturedRetailerOrder } from "./support/prepare-retailer-source";
import { expect, test } from "./support/e2e-test";

// Signed refund/group allocations must conserve actual statement activity without
// auto-booking Expense, duplicating retries, or creating owned Inventory.
test("reviews statement charge groups and refunds against captured retailer orders", async ({
  page,
  e2eRuntime,
}) => {
  test.setTimeout(180_000);
  const provider = e2eRuntime.googleProvider;
  if (!provider)
    throw new Error("Retailer extraction requires its local provider");
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
    "statementRow.record",
    statementInput,
  );
  expect(recorded.ok(), await recorded.text()).toBe(true);
  const result = recordStatementRowsOut.parse(recorded.body);
  expect(result.inserted).toBe(3);
  if (!result.batchId) throw new Error("Recorded statement batch missing");
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
    const evidence = await database.query.statementRow.findFirst({
      where: and(
        eq(schema.statementRow.source, statementInput.import.source),
        eq(schema.statementRow.batchId, result.batchId),
        eq(schema.statementRow.rawDescription, decision.description),
        notDeleted(schema.statementRow),
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
  const email = z
    .object({ user: z.object({ email: z.email() }) })
    .parse(await (await page.request.get("/api/auth/get-session")).json())
    .user.email;
  const purchaseCodes: string[] = [];
  for (const index of [0, 1]) {
    const orderToken = `${token}-${index}`;
    const orderNames = convergenceNames(orderToken);
    const url = `https://${names.host}/orders/${orderNames.orderId}`;
    const sku = `SYN-SKU-${orderToken}`;
    const productUrl = `https://${names.host}/products/${sku}`;
    provider.configure({
      email,
      message: {
        id: `synthetic-unused-${orderToken}`,
        payload: { headers: [] },
      },
      classification: { events: [] },
      extraction: {
        url,
        output: {
          status: "ready",
          reason: null,
          detail: null,
          candidate: {
            ...orderNames.retailerCandidate,
            merchant: names.name,
            lines: [
              {
                title: orderNames.productName,
                amount: 42.5,
                lineKind: "principal",
                costType: null,
                sku,
                quantity: 1,
                productUrl,
                imageUrl: null,
                seller: null,
              },
            ],
          },
        },
      },
    });
    const allowlist = await entityApi(page.request).update(
      "vendor",
      prerequisites.vendor.id,
      { browserDomains: [names.host] },
      { headers: { Origin: e2eRuntime.baseURL } },
    );
    expect(allowlist.ok(), await allowlist.text()).toBe(true);
    const run = await prepareCapturedRetailerOrder({
      db,
      actor,
      runtime: e2eRuntime,
      vendorId: prerequisites.vendor.id,
      token: orderToken,
      url,
      productUrl,
      expectedProductText: sku,
      retailerPages: {
        [url]: `<title>Synthetic order detail</title><main><h1>${orderNames.orderId}</h1><p>Ordered September 10, 2026. Delivered. USD 42.50</p><p>${orderNames.productName} SKU ${sku} quantity1</p><a href="${productUrl}">Product page</a></main>`,
        [productUrl]: `<main>${orderNames.productName} SKU ${sku} USD42.50</main>`,
      },
    });
    await gotoAuthenticatedPage(page, `/runs/${run.publicId}#work`);
    const approve = page.getByRole("button", {
      name: "Approve and import",
      exact: true,
    });
    await expect(approve).toBeDisabled();
    await chooseOption(
      page,
      page.getByLabel(`Product decision for ${orderNames.productName}`, {
        exact: true,
      }),
      "Create a new Product",
    );
    await expect(approve).toBeDisabled();
    await chooseOption(
      page,
      page.getByLabel("Trade for imported expenses", { exact: true }),
      "Other",
    );
    await expect(approve).toBeEnabled();
    await approve.click();
    const confirmation = page.getByRole("dialog", {
      name: "Approve and import",
      exact: true,
    });
    await confirmation
      .getByRole("button", { name: "Approve and import", exact: true })
      .click();
    await expect(confirmation).toHaveCount(0);
    // Each captured order is a member's own import Run; wait for its committed result.
    await expect(
      page.getByText("Prepared import approved and committed.", {
        exact: true,
      }),
    ).toBeVisible();
    const purchase = await database.query.purchase.findFirst({
      where: and(
        eq(schema.purchase.vendorId, vendorId),
        eq(schema.purchase.orderId, orderNames.orderId),
        notDeleted(schema.purchase),
      ),
    });
    if (!purchase)
      throw new Error("Reviewed captured order created no Purchase");
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
    const saved = page.waitForResponse((response) =>
      response
        .url()
        .endsWith("/operations/financialTransaction.allocateSettlement"),
    );
    await dialog
      .getByRole("button", { name: "Save allocation", exact: true })
      .click();
    const response = await saved;
    expect(response.ok(), await response.text()).toBe(true);
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
  await gotoDetailActions(
    page,
    `/purchases/${firstCode}#financial-settlement`,
    page.getByRole("button", { name: "Match statement activity", exact: true }),
  );
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
    "statementRow.record",
    statementInput,
  );
  expect(replay.ok(), await replay.text()).toBe(true);
  expect(recordStatementRowsOut.parse(replay.body)).toMatchObject({
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
