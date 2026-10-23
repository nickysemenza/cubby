import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import { getDb, notDeleted } from "~/server/db/helpers";
import * as schema from "~/server/db/schema";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { setMemberLoginParty } from "~/server/http/member-login";

import {
  createEvidenceHarnessContext,
  createFixtureGraph,
  ensureMemberParty,
} from "./fixtures/core";
import { performOperation } from "./support/dispatch-wire";
import { gotoDetailActions } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Refund review owns the real negative-amount interaction. Charge splits,
// statement intake/replay and retailer itemization have separate workflow owners.
test("reviews a signed refund without changing itemized Expenses or receiving stock", async ({
  page,
}) => {
  const name = `Synthetic refund ${Date.now()}`;
  const { db, actor } = await createEvidenceHarnessContext(page);
  const database = getDb(db);
  const member = await ensureMemberParty(page, name);
  await setMemberLoginParty(
    db,
    actor.userId,
    parseShortcodeFor("ledgerParty", member.shortcode),
    actor,
  );
  const seed = await createFixtureGraph(page, async (create) => {
    const vendor = await create("vendor", { name });
    const product = await create("product", {
      brandId: vendor.id,
      name: `${name} item`,
    });
    const purchase = await create("purchase", {
      vendorId: vendor.id,
      date: "2026-09-12",
      statedTotal: 42.5,
    });
    await create("expense", {
      name: `${name} itemized line`,
      purchaseId: purchase.id,
      productId: product.id,
      productQuantity: 1,
      cost: 42.5,
      lineBasis: "item_line",
      date: "2026-09-12",
      trade: "other",
      costType: "materials",
    });
    const card = await create("financialAccount", {
      name: `${name} card`,
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: member.shortcode,
    });
    const refund = await create("financialTransaction", {
      accountId: card.id,
      amount: -15,
      kind: "refund",
      status: "posted",
      postedDate: "2026-09-14",
      merchant: name,
    });
    return { purchase, product, refund };
  });
  const purchaseId = await resolveOrThrow(db, "purchase", seed.purchase.id);
  const transactionId = await resolveOrThrow(
    db,
    "financialTransaction",
    seed.refund.id,
  );
  const productId = await resolveOrThrow(db, "product", seed.product.id);
  const expenseRows = () =>
    database.query.expense.findMany({
      where: and(
        eq(schema.expense.purchaseId, purchaseId),
        notDeleted(schema.expense),
      ),
    });
  const allocationRows = () =>
    database.query.financialTransactionAllocation.findMany({
      where: and(
        eq(schema.financialTransactionAllocation.transactionId, transactionId),
        notDeleted(schema.financialTransactionAllocation),
      ),
    });
  const inventoryRows = () =>
    database.query.inventoryEntry.findMany({
      where: and(
        eq(schema.inventoryEntry.productId, productId),
        notDeleted(schema.inventoryEntry),
      ),
    });
  const expensesBefore = await expenseRows();
  expect(expensesBefore.map((row) => row.cost)).toEqual([42.5]);
  expect(await allocationRows()).toHaveLength(0);
  expect(await inventoryRows()).toHaveLength(0);
  await gotoDetailActions(
    page,
    `/purchases/${seed.purchase.id}#financial-settlement`,
    page.getByRole("button", { name: "Match statement activity", exact: true }),
  );
  await page
    .getByRole("button", { name: "Match statement activity", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Match statement activity",
    exact: true,
  });
  await dialog.getByRole("button").filter({ hasText: "Refund" }).click();
  const amount = dialog.getByRole("spinbutton", { name: "Amount 1" });
  const save = dialog.getByRole("button", {
    name: "Save allocation",
    exact: true,
  });
  await expect(amount).toHaveValue("-15.00");
  await amount.fill("15.00");
  await expect(save).toBeDisabled();
  expect(await allocationRows()).toHaveLength(0);
  await amount.fill("-15.00");
  await performOperation(page, "financialTransaction.allocateSettlement", () =>
    save.click(),
  );
  await expect(dialog).toHaveCount(0);
  expect(await allocationRows()).toMatchObject([
    { purchaseId, transactionId, amount: -15 },
  ]);
  expect(await expenseRows()).toEqual(expensesBefore);
  expect(await inventoryRows()).toHaveLength(0);
});
