import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import type {
  FinancialAccountId,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import type { PurchaseFilters } from "@cubby/schemas/purchase";
import { CURRENT_MEMBER_FILTER } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { createRepoEntity } from "tooling/factories/repo";
import { insertSettlementTransaction } from "tooling/settlement-fixtures";
import { seedEmailLinkDecision } from "tooling/shared-assessment-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb, unwrapDb, insertAndReturn } from "~/server/db/helpers";
import {
  auditLog,
  financialTransaction,
  importSourceClaim,
  importSourceOrder,
  ledgerParty,
  orderMailAttachment,
  orderMailEvent,
} from "~/server/db/schema";
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
import { startImportRunFixture } from "~/server/domains/purchase-import/service/import-run.fixtures";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { createMcpServer } from "~/server/mcp/server";
import {
  callMcpTool,
  kernelRequestContext,
} from "~/server/testing/mcp-test-utils";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  mergePurchases,
  readPurchaseById,
  updatePurchase,
  purchaseScaffold,
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
    expect(account.authorizedUserItems).toEqual([
      {
        entity: "ledgerParty",
        id: morgan.id,
        title: "Morgan",
        subtitle: "2026-06-01 → …",
        trailing: null,
      },
    ]);
    expect(account.fundingPeriodItems).toEqual([
      {
        entity: "ledgerParty",
        id: alex.id,
        title: "Alex",
        subtitle: "… → 2026-04-30",
        trailing: null,
      },
      {
        entity: "ledgerParty",
        id: household.id,
        title: "Shared funds",
        subtitle: "2026-05-01 → …",
        trailing: null,
      },
    ]);
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
    expect((await readPurchaseById(ctx.db, orderId)).purchaserId).toBe(alex.id);
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
    expect((await readPurchaseById(ctx.db, orderId)).purchaserId).toBe(
      morgan.id,
    );
    expect(await funder()).toMatchObject({ allocationKey: household.id });
    await updatePurchase(
      ctx.db,
      order.id,
      { vendorAccountId: null, date: "2026-05-01" },
      ctx.actor,
    );
    expect((await readPurchaseById(ctx.db, orderId)).purchaserId).toBeNull();
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
    expect((await readPurchaseById(ctx.db, orderId)).purchaserId).toBeNull();
    await updatePurchase(ctx.db, order.id, { date: "2026-06-01" }, ctx.actor);
    expect((await readPurchaseById(ctx.db, orderId)).purchaserId).toBe(alex.id);
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
    expect((await readPurchaseById(ctx.db, orderId)).purchaserId).toBe(alex.id);
    expect(await funder()).toMatchObject({
      allocationKey: alex.id,
      basis: "recorded",
    });
    expect(
      (
        await purchaseScaffold.read(ctx.db, {
          filters: { vendorId: vendor.id },
          sorts: [],
          pagination: {
            pageIndex: 0,
            pageSize: 10,
          },
        })
      ).data[0]?.purchaserId,
    ).toBe(alex.id);
    await updatePurchase(
      ctx.db,
      order.id,
      { purchaserOverrideId: null, date: null, vendorAccountId: null },
      ctx.actor,
    );
    expect((await readPurchaseById(ctx.db, orderId)).purchaserId).toBeNull();
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
    expect((await readPurchaseById(ctx.db, purchaseId)).purchaserId).toBeNull();
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
    expect((await readPurchaseById(ctx.db, purchaseId)).purchaserId).toBe(
      morgan.id,
    );
    const { output: vendorAccount } = await createRepoEntity(
      ctx,
      "vendorAccount",
      { vendorId: vendor.id, ledgerPartyId: alex.id },
    );
    const order = await readPurchaseById(ctx.db, purchaseId);
    await updatePurchase(
      ctx.db,
      order.id,
      { vendorAccountId: vendorAccount.id },
      ctx.actor,
    );
    expect((await readPurchaseById(ctx.db, purchaseId)).purchaserId).toBeNull();
    await updatePurchase(
      ctx.db,
      order.id,
      { vendorAccountId: null },
      ctx.actor,
    );
    await link(events[1]!.id);
    expect((await readPurchaseById(ctx.db, purchaseId)).purchaserId).toBeNull();
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
    expect((await readPurchaseById(ctx.db, keeperId)).purchaserOverrideId).toBe(
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

// Failures: the purchaser filter disagreeing with the displayed purchaserId
// (the set resolver dropping a source — accepted message or attachment
// sources through a claim alias, a household card's sole holder — or keeping
// a settlement_party_conflict order, shared card use or a deleted charge),
// `@me` not reaching MCP, and the member's Purchases section reading only
// overrides.
describe("purchaser filter", () => {
  const ctx = withTestDb();
  it("lists exactly the purchases whose displayed purchaserId is the member", async () => {
    const member = async (name: string) =>
      createRepoEntity(ctx, "ledgerParty", { name, kind: "member" });
    const { output: alex, entityId: alexId } = await member("Alex");
    const { output: morgan, entityId: morganId } = await member("Morgan");
    const { output: household } = await createRepoEntity(ctx, "ledgerParty", {
      name: "Shared funds",
      kind: "household",
    });
    const { output: vendor, entityId: vendorId } = await createRepoEntity(
      ctx,
      "vendor",
    );
    const account = async (owner: string) =>
      createRepoEntity(ctx, "vendorAccount", {
        vendorId: vendor.id,
        ledgerPartyId: owner,
      });
    const alexVendorAccount = await account(alex.id);
    const alexAccount = alexVendorAccount.output.id;
    const morganAccount = (await account(morgan.id)).output.id;
    const card = async (holder: string) =>
      (
        await createRepoEntity(ctx, "financialAccount", {
          identity: {
            kind: "credit_card",

            network: "visa",
          },
          ledgerPartyId: holder,
          primaryCardholderId: holder,
        })
      ).entityId;
    const alexCard = await card(alex.id);
    const morganCard = await card(morgan.id);
    const order = async (
      orderId: string,
      fields: { vendorAccountId?: string; purchaserOverrideId?: string } = {},
    ) =>
      createRepoEntity(ctx, "purchase", {
        vendorId: vendor.id,
        orderId,
        date: "2026-06-01",
        ...fields,
      });
    const settle = (accountId: FinancialAccountId, purchaseId: PurchaseId) =>
      insertSettlementTransaction(ctx.db, {
        accountId,
        purchaseId,
        kind: "purchase",
        status: "posted",
        amount: 25,
        transactionDate: "2026-06-01",
        postedDate: "2026-06-02",
      });

    const overridden = await order("SYN-OVERRIDE", {
      vendorAccountId: morganAccount,
      purchaserOverrideId: alex.id,
    });
    const byAccount = await order("SYN-ACCOUNT", {
      vendorAccountId: alexAccount,
    });
    const byCard = await order("SYN-CARD");
    await settle(alexCard, byCard.entityId);
    const byEmail = await order("SYN-EMAIL");
    const original = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: alexId,
      mailboxId: "synthetic-filter",
      messageId: "synthetic-filter-message",
      vendorId,
      sender: "receipts@example.test",
      subject: "Synthetic receipt",
      receivedAt: new Date("2026-06-01T12:00:00Z"),
      rawChecksum: "f".repeat(64),
      content: { bodyText: "Synthetic receipt", bodyHtml: null, snippet: null },
    });
    const event = await insertAndReturn(ctx.db, orderMailEvent, {
      orderMailId: original.id,
      event: "placed",
      orderId: "SYN-EMAIL",
      sourceKey: "synthetic-filter-event",
    });
    await seedEmailLinkDecision(ctx.db, {
      eventId: event.id,
      purchaseId: byEmail.entityId,
      decision: "linked",
      evidenceChecksum: "f".repeat(64),
      decidedByUserId: ctx.actor.userId,
      proposedBy: "member",
    });
    // Alex's order paid on Morgan's card: a candidate for both, decided for neither.
    const conflicted = await order("SYN-CONFLICT", {
      vendorAccountId: alexAccount,
    });
    await settle(morganCard, conflicted.entityId);

    const morgans = await order("SYN-MORGAN", {
      vendorAccountId: morganAccount,
    });

    // Alex is the signed-in member (`@me` below) and runs the import.
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ userId: ctx.actor.userId })
      .where(eq(ledgerParty.id, alexId));
    // Morgan's mail-only orders, each accepted on an alias of the claim that
    // names the Email (an attachment id may hold colons).
    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: alexId,
      vendorAccountId: alexVendorAccount.entityId,
    });
    const accepted = async (orderId: string, attachmentId?: string) => {
      const created = await order(orderId);
      const checksum = (attachmentId ? "b" : "a").repeat(64);
      const messageId = `synthetic-${orderId}`;
      const original = await syntheticRetainedMail(ctx.db, {
        ledgerPartyId: morganId,
        mailboxId: "synthetic-filter-morgan",
        messageId,
        vendorId,
        sender: "receipts@example.test",
        subject: "Synthetic receipt",
        receivedAt: new Date("2026-06-01T12:00:00Z"),
        rawChecksum: checksum,
        content: {
          bodyText: "Synthetic receipt",
          bodyHtml: null,
          snippet: null,
        },
      });
      let externalKey = `gmail:synthetic-filter-morgan:${messageId}`;
      if (attachmentId) {
        await getDb(ctx.db)
          .insert(orderMailAttachment)
          .values({
            orderMailId: original.id,
            providerAttachmentId: attachmentId,
            filename: "receipt.pdf",
            mimeType: "application/pdf",
            checksum: "c".repeat(64),
          });
        externalKey += `:attachment:${attachmentId}`;
      }
      const claim = async (key: string, canonicalClaimId?: string) => {
        const [row] = await getDb(ctx.db)
          .insert(importSourceClaim)
          .values({
            ledgerPartyId: morganId,
            kind: attachmentId ? "mail_attachment" : "mail_message",
            externalKey: key,
            canonicalClaimId,
            checksum,
            firstRunId: run.id,
            lastRunId: run.id,
          })
          .returning({ id: importSourceClaim.id });
        if (!row) throw new Error("Synthetic claim missing");
        return row.id;
      };
      const root = await claim(externalKey);
      await getDb(ctx.db)
        .insert(importSourceOrder)
        .values({
          sourceClaimId: await claim(`${externalKey}:historical-alias`, root),
          orderKey: orderId,
          purchaseId: created.entityId,
          checksum,
          outputFingerprint: `synthetic-${orderId}`,
        });
      return created;
    };
    const byMessage = await accepted("SYN-MESSAGE");
    const byAttachment = await accepted("SYN-ATTACHMENT", "receipt:part-1");

    // Household cards Morgan holds; Alex is authorized on the shared one by
    // the order date. A household card never conflicts, so its sole holder
    // outranks Alex's Vendor Account; shared use identifies nobody.
    const householdCard = async (alexFrom: string) =>
      (
        await createRepoEntity(ctx, "financialAccount", {
          identity: {
            kind: "credit_card",

            network: "visa",
          },
          ledgerPartyId: household.id,
          primaryCardholderId: morgan.id,
          authorizedUsers: [
            { ledgerPartyId: alex.id, validFrom: alexFrom, validTo: null },
          ],
        })
      ).entityId;
    const bySoleCard = await order("SYN-SOLE-CARD", {
      vendorAccountId: alexAccount,
    });
    await settle(await householdCard("2026-07-01"), bySoleCard.entityId);
    const byShared = await order("SYN-SHARED-CARD");
    await settle(await householdCard("2026-05-01"), byShared.entityId);
    // A deleted charge on Morgan's card neither conflicts nor pays.
    const deletedCharge = await order("SYN-DELETED-CHARGE", {
      vendorAccountId: alexAccount,
    });
    const removed = await settle(morganCard, deletedCharge.entityId);
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ deletedAt: new Date() })
      .where(eq(financialTransaction.id, removed.id));

    const page = { pageIndex: 0, pageSize: 50 };
    const ids = async (filters: PurchaseFilters) =>
      (
        await purchaseScaffold.read(ctx.db, {
          filters,
          sorts: [],
          pagination: page,
        })
      ).data
        .map((row) => row.id)
        .sort();
    const displayed = (
      await purchaseScaffold.read(ctx.db, {
        filters: {},
        sorts: [],
        pagination: page,
      })
    ).data;
    const shownFor = (party: string) =>
      displayed
        .filter((row) => row.purchaserId === party)
        .map((row) => row.id)
        .sort();
    for (const unknown of [conflicted, byShared])
      expect(
        displayed.find((row) => row.id === unknown.output.id)?.purchaserId,
      ).toBeNull();
    expect(shownFor(alex.id)).toEqual(
      [overridden, byAccount, byCard, byEmail, deletedCharge]
        .map(({ output }) => output.id)
        .sort(),
    );
    expect(shownFor(morgan.id)).toEqual(
      [morgans, byMessage, byAttachment, bySoleCard]
        .map(({ output }) => output.id)
        .sort(),
    );
    for (const party of [alex.id, morgan.id])
      expect(await ids({ purchaserId: [party] })).toEqual(shownFor(party));
    expect(await ids({ purchaserIdExclude: [alex.id] })).toEqual(
      displayed
        .filter((row) => row.purchaserId !== alex.id)
        .map((row) => row.id)
        .sort(),
    );

    // MCP entity_read resolves `@me` to the actor's member.
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const listed = await callMcpTool(
      createMcpServer(),
      "entity_read",
      {
        action: "list",
        entity: "purchase",
        filters: { purchaserId: [CURRENT_MEMBER_FILTER] },
        fields: ["id"],
      },
      kernelRequestContext(entityKernel),
      { entityKernel },
    );
    expect(listed.isError).not.toBe(true);
    expect(
      z
        .object({ items: z.array(z.object({ id: z.string() })) })
        .parse(listed.structuredContent)
        .items.map((item) => item.id)
        .sort(),
    ).toEqual(shownFor(alex.id));

    // The member's Purchases section reads through the same filter.
    expect(
      entityInspectorMetadata.ledgerParty.detail.sections.find(
        (section) =>
          section.kind === "relation" && section.relation === "purchases",
      ),
    ).toMatchObject({ filter: { descriptor: "purchaserId" } });
  });
});
