import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import * as schema from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { setMemberLoginParty } from "~/server/repo/member-login";
import {
  convergenceNames,
  createConvergenceFixtures,
} from "../../tooling/convergence-harness";
import {
  createEntityFixture,
  createEvidenceHarnessContext,
  ensureMemberParty,
} from "./fixtures-core";
import { escapeRegExp, gotoAuthenticatedPage } from "./e2e-helpers";
import { prepareCapturedRetailerOrder } from "./prepare-retailer-source";
import { expect, test } from "./e2e-test";

// Signed refund/group allocations must conserve actual CSV activity without
// auto-booking Expense, duplicating retries, or creating owned Inventory.
test("reviews CSV charge groups and refunds against captured retailer orders", async ({
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
  const prerequisites = await createConvergenceFixtures(
    (entity, overrides) => createEntityFixture(page, entity, overrides),
    member.shortcode,
    names,
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
  const csv = {
    name: `${token}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id",
        `2026-09-12,${names.name},Clothing,${names.statementAccount},${descriptions.charge},,-85.00,${token}-charge`,
        `2026-09-14,${names.name},Refund,${names.statementAccount},${descriptions.refund},,15.00,${token}-refund`,
        `2026-09-15,Synthetic Card Payment,Credit Card Payment,${names.statementAccount},${descriptions.held},,85.00,${token}-held`,
      ].join("\n"),
    ),
  };
  const expenseCountBefore = (
    await database.query.expense.findMany({ where: notDeleted(schema.expense) })
  ).length;
  await gotoAuthenticatedPage(page, "/statement-rows/import");
  await page.getByLabel("Statement CSV file").setInputFiles(csv);
  await expect(
    page.getByText(new RegExp(escapeRegExp(`${names.name} card`))).first(),
  ).toBeVisible();
  for (const kind of ["charge", "refund"] as const) {
    await page
      .getByRole("checkbox", {
        name: `Record ${descriptions[kind]}`,
        exact: true,
      })
      .check();
    await page
      .getByLabel(`Transaction kind for ${descriptions[kind]}`, { exact: true })
      .selectOption(kind === "charge" ? "purchase" : "refund");
  }
  await expect(
    page.getByRole("checkbox", {
      name: `Record ${descriptions.held}`,
      exact: true,
    }),
  ).not.toBeChecked();
  expect(
    await database.query.financialTransaction.findMany({
      where: eq(schema.financialTransaction.accountId, cardId),
    }),
  ).toHaveLength(0);
  await page
    .getByRole("button", {
      name: "Save rows and create 2 reviewed transactions",
      exact: true,
    })
    .click();
  await expect(page.getByText(/2 transactions created/u)).toBeVisible();
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
    const allowlist = await page.request.patch(
      `/api/v1/vendors/${prerequisites.vendor.id}`,
      {
        headers: { Origin: e2eRuntime.baseURL },
        data: { browserDomains: [names.host] },
      },
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
    await gotoAuthenticatedPage(page, `/runs/${run.publicId}`);
    const approve = page.getByRole("button", {
      name: "Approve and import",
      exact: true,
    });
    await expect(approve).toBeDisabled();
    await page
      .getByLabel(`Product decision for ${orderNames.productName}`, {
        exact: true,
      })
      .selectOption("new");
    await expect(approve).toBeDisabled();
    await page
      .getByLabel("Trade for imported expenses", { exact: true })
      .selectOption("other");
    await expect(approve).toBeEnabled();
    await approve.click();
    // Each captured order is a member's own import Run.
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
  await gotoAuthenticatedPage(page, `/purchases/${firstCode}`);
  await page
    .getByRole("button", { name: "Match statement activity", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Match statement activity",
    exact: true,
  });
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
  await dialog
    .getByRole("button", { name: "Save allocation", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect((await allocationRows()).map((row) => row.amount)).toEqual([
    42.5, 42.5,
  ]);
  await gotoAuthenticatedPage(page, `/purchases/${firstCode}`);
  await page
    .getByRole("button", { name: "Match statement activity", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Match statement activity",
    exact: true,
  });
  await expect(
    dialog.getByRole("button").filter({ hasText: "Charge" }),
  ).toHaveCount(0);
  await dialog.getByRole("button").filter({ hasText: "Refund" }).click();
  await expect(
    dialog.getByRole("spinbutton", { name: "Amount 1" }),
  ).toHaveValue("-15.00");
  await dialog.getByRole("spinbutton", { name: "Amount 1" }).fill("15.00");
  await expect(
    dialog.getByRole("button", { name: "Save allocation", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("spinbutton", { name: "Amount 1" }).fill("-15.00");
  await dialog
    .getByRole("button", { name: "Save allocation", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
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
  await gotoAuthenticatedPage(page, "/statement-rows/import");
  await page.getByLabel("Statement CSV file").setInputFiles(csv);
  await expect(
    page.getByText(new RegExp(escapeRegExp(`${names.name} card`))).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save 3 source rows", exact: true })
    .click();
  await expect(page.getByText(/0 transactions created/u)).toBeVisible();
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
