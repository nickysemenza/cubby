import { financialTransactionUpdateData } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { financialTransactionAllocation } from "~/server/db/schema";
import { getPurchaseByShortcode } from "~/server/domains/purchase/repo/purchase";
import { purchasePaymentAccountsRelationAdapter } from "~/server/domains/purchase/repo/purchase-payment-accounts";
import { listPurchaseSettlementCandidates } from "~/server/domains/purchase/repo/purchase-settlement-candidates";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { applyFinancialSettlementAllocation } from "./financial-settlement-allocation";
import { updateFinancialTransaction } from "./financial-transaction";

/**
 * The incident shape, synthetic: member A's gift-card-paid order was settled
 * against a one-cent-off charge on member B's card by amount and date alone.
 */
describe("settlement conflicts", () => {
  const ctx = withTestDb();

  async function world() {
    const buyer = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Order member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const other = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other member",
      kind: "member",
      userId: null,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Example Store ${crypto.randomUUID()}`,
    });
    const vendorAccount = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: buyer.id,
    });
    const card = (name: string, owner: typeof buyer, last4: string) =>
      insertWithShortcode(ctx.db, "financialAccount", {
        name,
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        ledgerPartyId: owner.id,
        primaryCardholderId: owner.id,
        cardNumbers: [
          {
            last4,
            kind: "primary",
            validFrom: null,
            validTo: null,
            note: null,
          },
        ],
      });
    const buyerCard = await card("Order member card", buyer, "2505");
    const otherCard = await card("Other member card", other, "3129");
    const giftCard = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Store gift card",
      identity: { kind: "stored_value", provider: "Example Store" },
      providerVendorId: vendor.id,
      ledgerPartyId: buyer.id,
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: vendorAccount.id,
      date: "2026-09-14",
      orderId: "SYN-1001",
      statedTotal: 13.59,
    });
    const charge = (accountId: typeof buyerCard.id, amount: number) =>
      insertWithShortcode(ctx.db, "financialTransaction", {
        accountId,
        kind: "purchase",
        status: "posted",
        amount,
        transactionDate: null,
        postedDate: "2026-09-13",
        merchant: "Example Store",
      });
    return { buyer, buyerCard, otherCard, giftCard, order, charge };
  }

  const gaps = async (shortcode: string) =>
    (await getPurchaseByShortcode(ctx.db, shortcode))?.dataQuality.gaps.map(
      (gap) => gap.check,
    ) ?? [];

  const allocate = (
    transactionId: string,
    purchaseId: string,
    amount: number,
  ) =>
    updateFinancialTransaction(
      ctx.db,
      parseShortcodeFor("financialTransaction", transactionId),
      financialTransactionUpdateData.parse({
        allocations: [{ purchaseId, amount }],
      }),
      ctx.actor,
    );

  it("refuses another member's charge, and an acknowledged allocation records the exception", async () => {
    const { otherCard, order, charge } = await world();
    const wrong = await charge(otherCard.id, 13.59);
    await expect(
      allocate(wrong.shortcode, order.shortcode, 13.59),
    ).rejects.toThrow(/vendor-account member/);

    await applyFinancialSettlementAllocation(
      ctx.db,
      {
        transactionId: parseShortcodeFor(
          "financialTransaction",
          wrong.shortcode,
        ),
        priorAllocations: [],
        allocations: [
          {
            purchaseId: parseShortcodeFor("purchase", order.shortcode),
            amount: 13.59,
          },
        ],
        acknowledgeConflicts: {
          note: "Shared card, confirmed by both members.",
        },
      },
      ctx.actor,
    );
    const quality = (await getPurchaseByShortcode(ctx.db, order.shortcode))
      ?.dataQuality;
    expect(quality?.gaps.map((gap) => gap.check)).not.toContain(
      "settlement_party_conflict",
    );
    expect(quality?.exceptions).toContainEqual(
      expect.objectContaining({
        check: "settlement_party_conflict",
        reason: "confirmed_shared_use",
        state: "active",
      }),
    );
  });

  it("flags a conflicting allocation that predates the guard", async () => {
    const { otherCard, order, charge } = await world();
    const wrong = await charge(otherCard.id, 13.58);
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: wrong.id,
      purchaseId: order.id,
      amount: 13.58,
    });
    expect(await gaps(order.shortcode)).toContain("settlement_party_conflict");
    // The settling card's sole user is not the order's member: purchaser stays unknown.
    expect(
      (await getPurchaseByShortcode(ctx.db, order.shortcode))?.purchaserId,
    ).toBeNull();
  });

  it("refuses a card the order's linked payment accounts do not name, until the link changes", async () => {
    const { buyerCard, giftCard, order, charge } = await world();
    await purchasePaymentAccountsRelationAdapter.execute(
      { db: ctx.db, actorContext: ctx.actor },
      "attach",
      order.shortcode,
      [{ id: giftCard.shortcode }],
    );
    expect(
      await purchasePaymentAccountsRelationAdapter.list(
        ctx.db,
        order.shortcode,
      ),
    ).toEqual([
      expect.objectContaining({
        accountId: giftCard.shortcode,
        source: "link",
      }),
    ]);
    const cardCharge = await charge(buyerCard.id, 13.59);
    await expect(
      allocate(cardCharge.shortcode, order.shortcode, 13.59),
    ).rejects.toThrow(/accounts that paid the order/);

    const balanceDebit = await charge(giftCard.id, 13.59);
    await allocate(balanceDebit.shortcode, order.shortcode, 13.59);
    expect(await gaps(order.shortcode)).not.toContain(
      "settlement_tender_conflict",
    );
  });

  it("ranks a one-cent near miss below exact and a conflicting account last", async () => {
    const { buyerCard, otherCard, order, charge } = await world();
    const exact = await charge(buyerCard.id, 13.59);
    const near = await charge(buyerCard.id, 13.58);
    const conflicting = await charge(otherCard.id, 13.59);
    const ranked = await listPurchaseSettlementCandidates(
      ctx.db,
      parseShortcodeFor("purchase", order.shortcode),
    );
    const row = (id: string) =>
      ranked.find((candidate) => candidate.transactionId === id);
    expect(ranked.map((candidate) => candidate.transactionId)).toEqual([
      exact.shortcode,
      near.shortcode,
      conflicting.shortcode,
    ]);
    expect(row(exact.shortcode)).toMatchObject({
      exactAmount: true,
      nearAmount: false,
      conflicts: [],
    });
    expect(row(near.shortcode)).toMatchObject({
      exactAmount: false,
      nearAmount: true,
    });
    expect(row(conflicting.shortcode)?.conflicts).toEqual(["party"]);
  });
});
