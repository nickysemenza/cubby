import { eq } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { createRepoEntity } from "tooling/factories/repo";
import { insertSettlementTransaction } from "tooling/settlement-fixtures";
import { seedEmailLinkDecision } from "tooling/shared-assessment-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb, insertAndReturn } from "~/server/db/helpers";
import { auditLog, orderMailEvent } from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import {
  createFinancialAccount,
  updateFinancialAccount,
} from "~/server/domains/financial-account/repo";
import { loadExpenseAllocations } from "~/server/domains/household-contribution/repo/allocation";
import {
  deleteLedgerParties,
  updateLedgerParty,
  mergeLedgerParties,
} from "~/server/domains/ledger-party/repo/ledger-party";
import { syntheticRetainedMail } from "~/server/domains/purchase-import/service/gmail/retained-mail.fixtures";

import {
  mergePurchases,
  getPurchaseByID,
  updatePurchase,
  purchaseList,
} from "./purchase";

// Failures: shared funding must not identify the shopper; date corrections must
// change inherited values without rewriting explicit purchase/expense overrides.
describe("dated card attribution", () => {
  const ctx = withTestDb();
  it("resolves sole/shared use and funding independently, with live history corrections and overrides", async () => {
    const { output: alex } = await createRepoEntity(ctx, "ledgerParty", {
      name: "Alex",
      kind: "member",
    });
    const { output: morgan } = await createRepoEntity(ctx, "ledgerParty", {
      name: "Morgan",
      kind: "member",
    });
    const { output: household } = await createRepoEntity(ctx, "ledgerParty", {
      name: "Shared funds",
      kind: "household",
    });
    const { output: vendor } = await createRepoEntity(ctx, "vendor");
    const { output: account, entityId: accountId } = await createRepoEntity(
      ctx,
      "financialAccount",
      {
        identity: {
          kind: "credit_card",
          issuer: "Example Bank",
          network: "visa",
        },
        ledgerPartyId: household.id,
        primaryCardholderId: alex.id,
        authorizedUsers: [
          { ledgerPartyId: morgan.id, validFrom: "2026-06-01", validTo: null },
        ],
        fundingPeriods: [
          { ledgerPartyId: alex.id, validFrom: null, validTo: "2026-04-30" },
          {
            ledgerPartyId: household.id,
            validFrom: "2026-05-01",
            validTo: null,
          },
        ],
      },
    );
    const { output: vendorAccount } = await createRepoEntity(
      ctx,
      "vendorAccount",
      { vendorId: vendor.id, ledgerPartyId: morgan.id },
    );
    const { output: order, entityId: orderId } = await createRepoEntity(
      ctx,
      "purchase",
      {
        vendorId: vendor.id,
        vendorAccountId: vendorAccount.id,
        date: "2026-05-15",
      },
    );
    const { output: line, entityId: lineId } = await createRepoEntity(
      ctx,
      "expense",
      { purchaseId: order.id, trade: "other", cost: 40, date: "2026-05-15" },
    );
    await insertSettlementTransaction(ctx.db, {
      accountId,
      purchaseId: orderId,
      kind: "purchase",
      status: "posted",
      amount: 40,
      transactionDate: "2026-04-30",
      postedDate: "2026-05-02",
    });
    expect((await getPurchaseByID(ctx.db, orderId)).purchaserId).toBe(alex.id);
    const funder = async () =>
      (await loadExpenseAllocations(ctx.db, { expenseIds: [lineId] })).find(
        (row) => row.role === "funder",
      );
    expect(await funder()).toMatchObject({
      allocationKey: alex.id,
      basis: "derived_from_payment",
      cents: 4000n,
    });
    await updateFinancialAccount(
      ctx.db,
      account.id,
      {
        authorizedUsers: [
          { ledgerPartyId: morgan.id, validFrom: "2026-05-01", validTo: null },
        ],
        fundingPeriods: [
          { ledgerPartyId: household.id, validFrom: null, validTo: null },
        ],
      },
      ctx.actor,
    );
    expect((await getPurchaseByID(ctx.db, orderId)).purchaserId).toBe(
      morgan.id,
    );
    expect(await funder()).toMatchObject({ allocationKey: household.id });
    await updatePurchase(
      ctx.db,
      order.id,
      { vendorAccountId: null, date: "2026-05-01" },
      ctx.actor,
    );
    expect((await getPurchaseByID(ctx.db, orderId)).purchaserId).toBeNull();
    await updateFinancialAccount(
      ctx.db,
      account.id,
      {
        authorizedUsers: [
          {
            ledgerPartyId: morgan.id,
            validFrom: "2026-05-01",
            validTo: "2026-05-31",
          },
        ],
      },
      ctx.actor,
    );
    await updatePurchase(ctx.db, order.id, { date: "2026-05-31" }, ctx.actor);
    expect((await getPurchaseByID(ctx.db, orderId)).purchaserId).toBeNull();
    await updatePurchase(ctx.db, order.id, { date: "2026-06-01" }, ctx.actor);
    expect((await getPurchaseByID(ctx.db, orderId)).purchaserId).toBe(alex.id);
    await updatePurchase(
      ctx.db,
      order.id,
      { purchaserOverrideId: alex.id },
      ctx.actor,
    );
    await updateExpense(
      ctx.db,
      line.id,
      { funders: [{ partyId: alex.id, weight: 1 }] },
      ctx.actor,
    );
    await updateFinancialAccount(
      ctx.db,
      account.id,
      { authorizedUsers: [], fundingPeriods: [] },
      ctx.actor,
    );
    expect((await getPurchaseByID(ctx.db, orderId)).purchaserId).toBe(alex.id);
    expect(await funder()).toMatchObject({
      allocationKey: alex.id,
      basis: "recorded",
    });
    expect(
      (
        await purchaseList(ctx.db, { vendorId: vendor.id }, [], {
          pageIndex: 0,
          pageSize: 10,
        })
      ).data[0]?.purchaserId,
    ).toBe(alex.id);
    await updatePurchase(
      ctx.db,
      order.id,
      { purchaserOverrideId: null, date: null, vendorAccountId: null },
      ctx.actor,
    );
    expect((await getPurchaseByID(ctx.db, orderId)).purchaserId).toBeNull();
  });
  it("rejects invalid memberships and preserves live history references through party lifecycle actions", async () => {
    const { output: primary } = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
    });
    const { output: member } = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
    });
    const { output: guest } = await createRepoEntity(ctx, "ledgerParty", {
      kind: "guest",
    });
    const { output: account, entityId: accountId } = await createRepoEntity(
      ctx,
      "financialAccount",
      {
        identity: {
          kind: "credit_card",
          issuer: "Example Bank",
          network: "visa",
        },
        primaryCardholderId: primary.id,
        authorizedUsers: [
          { ledgerPartyId: member.id, validFrom: "2026-06-01", validTo: null },
        ],
      },
    );
    await updateFinancialAccount(
      ctx.db,
      account.id,
      { notes: "Synthetic note" },
      ctx.actor,
    );
    const audit = await unwrapDb(ctx.db)
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(eq(auditLog.entityId, accountId));
    expect(
      audit
        .filter((row) => row.changes !== null)
        .flatMap((row) => Object.keys(row.changes!)),
    ).toEqual(["notes"]);
    await expect(
      updateFinancialAccount(
        ctx.db,
        account.id,
        {
          authorizedUsers: [
            { ledgerPartyId: guest.id, validFrom: null, validTo: null },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("must be household members");
    await expect(
      updateFinancialAccount(
        ctx.db,
        account.id,
        {
          authorizedUsers: [
            { ledgerPartyId: primary.id, validFrom: null, validTo: null },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("cannot also be an authorized user");
    await expect(
      deleteLedgerParties(ctx.db, [member.id], ctx.actor),
    ).rejects.toThrow("history");
    await expect(
      updateLedgerParty(ctx.db, member.id, { kind: "guest" }, ctx.actor),
    ).rejects.toThrow("history");
    await expect(
      mergeLedgerParties(
        ctx.db,
        { keepId: primary.id, mergeIds: [member.id] },
        ctx.actor,
      ),
    ).rejects.toThrow("history");
    await expect(
      createFinancialAccount(
        ctx.db,
        buildEntity("financialAccount", {
          identity: { kind: "cash" },
          primaryCardholderId: primary.id,
        }),
        ctx.actor,
      ),
    ).rejects.toThrow("credit-card");
    expect(() =>
      buildEntity("financialAccount", {
        fundingPeriods: [
          { ledgerPartyId: member.id, validFrom: null, validTo: "2026-06-01" },
          { ledgerPartyId: primary.id, validFrom: "2026-06-01", validTo: null },
        ],
      }),
    ).toThrow("must not overlap");
  });

  it("uses reviewed Email evidence, excludes suggestions, and leaves conflicting members unknown", async () => {
    const { output: alex, entityId: alexId } = await createRepoEntity(
      ctx,
      "ledgerParty",
      { name: "Alex", kind: "member" },
    );
    const { output: morgan, entityId: morganId } = await createRepoEntity(
      ctx,
      "ledgerParty",
      { name: "Morgan", kind: "member" },
    );
    const { output: vendor, entityId: vendorId } = await createRepoEntity(
      ctx,
      "vendor",
    );
    const { entityId: purchaseId } = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.id,
      orderId: "SYN-CARD-EMAIL",
      date: "2026-06-01",
    });
    const events = await Promise.all(
      [morganId, alexId].map(async (partyId, index) => {
        const checksum = "e".repeat(64);
        const original = await syntheticRetainedMail(ctx.db, {
          ledgerPartyId: partyId,
          mailboxId: `synthetic-card-${index}`,
          messageId: `synthetic-card-message-${index}`,
          vendorId,
          sender: "receipts@example.test",
          subject: "Synthetic receipt",
          receivedAt: new Date("2026-06-01T12:00:00Z"),
          rawChecksum: checksum,
          content: {
            bodyText: "Synthetic card receipt",
            bodyHtml: null,
            snippet: null,
          },
        });
        return insertAndReturn(ctx.db, orderMailEvent, {
          orderMailId: original.id,
          event: "placed",
          orderId: "SYN-CARD-EMAIL",
          sourceKey: `synthetic-card-event-${index}`,
        });
      }),
    );
    expect((await getPurchaseByID(ctx.db, purchaseId)).purchaserId).toBeNull();
    const link = (eventId: string) =>
      seedEmailLinkDecision(ctx.db, {
        eventId,
        purchaseId,
        decision: "linked",
        evidenceChecksum: "e".repeat(64),
        decidedByUserId: ctx.actor.userId,
        proposedBy: "member",
      });
    await link(events[0]!.id);
    expect((await getPurchaseByID(ctx.db, purchaseId)).purchaserId).toBe(
      morgan.id,
    );
    const { output: vendorAccount } = await createRepoEntity(
      ctx,
      "vendorAccount",
      { vendorId: vendor.id, ledgerPartyId: alex.id },
    );
    const order = await getPurchaseByID(ctx.db, purchaseId);
    await updatePurchase(
      ctx.db,
      order.id,
      { vendorAccountId: vendorAccount.id },
      ctx.actor,
    );
    expect((await getPurchaseByID(ctx.db, purchaseId)).purchaserId).toBeNull();
    await updatePurchase(
      ctx.db,
      order.id,
      { vendorAccountId: null },
      ctx.actor,
    );
    await link(events[1]!.id);
    expect((await getPurchaseByID(ctx.db, purchaseId)).purchaserId).toBeNull();
  });

  it("preserves purchaser overrides on merge and refuses conflicting explicit purchasers", async () => {
    const { output: alex } = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
    });
    const { output: morgan } = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
    });
    const { output: vendor } = await createRepoEntity(ctx, "vendor");
    const { output: keeper, entityId: keeperId } = await createRepoEntity(
      ctx,
      "purchase",
      { vendorId: vendor.id, orderId: null },
    );
    const { output: incoming } = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.id,
      orderId: null,
      purchaserOverrideId: alex.id,
    });
    await mergePurchases(
      ctx.db,
      { keepId: keeper.id, mergeIds: [incoming.id] },
      ctx.actor,
    );
    expect((await getPurchaseByID(ctx.db, keeperId)).purchaserOverrideId).toBe(
      alex.id,
    );
    const { output: conflicting } = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.id,
      orderId: null,
      purchaserOverrideId: morgan.id,
    });
    await expect(
      mergePurchases(
        ctx.db,
        { keepId: keeper.id, mergeIds: [conflicting.id] },
        ctx.actor,
      ),
    ).rejects.toThrow("conflicting purchaser overrides");
  });
});
