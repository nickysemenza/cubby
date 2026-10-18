import { parseEntityId } from "@cubby/schemas/identifiers";
import type { ExtractedOrderCandidate } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  expense,
  emailFinancialAssociation,
  ledgerParty,
  orderMail,
  purchase as purchaseTable,
  runFinding,
  vendor as vendorTable,
} from "~/server/db/schema";
import { memberImport } from "~/server/domains/purchase-import/operations/order-import.fixtures";
import { resolveRunFinding } from "~/server/domains/purchase-import/repo/findings";
import { prepareSourceOrderReconciliation } from "~/server/domains/purchase-import/repo/reconciliation";
import { prepareMailFinancialEvent } from "~/server/domains/purchase-import/service/mail-financial-event";
import { settlementRefsFor } from "~/server/generic/entity-links/repo/entity-external-ids";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  convergeFinancialTransaction,
  readFinancialWork,
} from "./financial-convergence";

// Automatic writes need accepted identity, exact cents and unchanged lineage.
// A sole nearby candidate, transfer leg, or replay after an edit cannot mint spend.
describe("server verified financial convergence", () => {
  const ctx = withTestDb();
  async function fixture(
    kind: "purchase" | "account_transfer" = "purchase",
    allocated = true,
  ) {
    const party = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic household",
      kind: "household",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic cash",
      identity: { kind: "cash" },
      ledgerPartyId: party.output.id,
      provisional: false,
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic store",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-01",
      statedTotal: 25,
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind,
      amount: 25,
      status: "posted",
      transactionDate: "2026-09-01",
      postedDate: "2026-09-03",
      merchant: "Synthetic store",
      sourceRefs: [
        { source: "synthetic-bank", externalId: "synthetic-charge-1" },
      ],
      allocations: allocated
        ? [{ purchaseId: purchase.output.id, amount: 25 }]
        : [],
    });
    return { purchase, transaction, vendor, account };
  }
  async function liveCosts() {
    return getDb(ctx.db)
      .select({ cost: expense.cost })
      .from(expense)
      .where(notDeleted(expense));
  }
  it("books an accepted identity once and refuses replay after the accepted amount changes", async () => {
    const { transaction } = await fixture();
    const input = { transactionId: transaction.output.id };
    expect(
      await readFinancialWork(ctx.db, [transaction.output.id], ctx.actor),
    ).toMatchObject([
      { canApplyAutomatically: true, effect: "create_aggregate" },
    ]);
    expect(await liveCosts()).toEqual([]);
    const result = await convergeFinancialTransaction(ctx.db, input, ctx.actor);
    expect(result.status).toBe("applied");
    expect(
      await convergeFinancialTransaction(ctx.db, input, ctx.actor),
    ).toMatchObject({ status: "already_recorded" });
    expect(await liveCosts()).toEqual([{ cost: 25 }]);
    await getDb(ctx.db)
      .update(expense)
      .set({ cost: 30 })
      .where(eq(expense.bookingTransactionCode, transaction.output.id));
    expect(
      await convergeFinancialTransaction(ctx.db, input, ctx.actor),
    ).toMatchObject({ status: "review_required" });
    expect(await liveCosts()).toEqual([{ cost: 30 }]);
  });
  // A household-funded card owned by another member's party refused its
  // primary cardholder: access read only the owner, never the card's people.
  it.each([
    ["the primary cardholder, by charge date", "cardholder", "2026-09-01"],
    ["the primary cardholder, by a lag-safe posting date", "cardholder", null],
    ["an authorized user on the charge date", "authorized", "2026-09-01"],
  ] as const)(
    "books a household-funded card for %s",
    async (_, role, transactionDate) => {
      const household = await createRepoEntity(ctx, "ledgerParty", {
        name: "Synthetic household",
        kind: "household",
      });
      const holder = await createRepoEntity(ctx, "ledgerParty", {
        name: "Synthetic holder",
        kind: "member",
      });
      await getDb(ctx.db)
        .update(ledgerParty)
        .set({ userId: ctx.actor.userId })
        .where(eq(ledgerParty.shortcode, holder.output.id));
      const owner = await createRepoEntity(ctx, "ledgerParty", {
        name: "Synthetic account owner",
        kind: "member",
      });
      const account = await createRepoEntity(ctx, "financialAccount", {
        name: "Synthetic shared card",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        ledgerPartyId: owner.output.id,
        primaryCardholderId:
          role === "cardholder" ? holder.output.id : owner.output.id,
        authorizedUsers:
          role === "authorized"
            ? [
                {
                  ledgerPartyId: holder.output.id,
                  validFrom: "2026-08-01",
                  validTo: null,
                },
              ]
            : [],
        fundingPeriods: [
          {
            ledgerPartyId: household.output.id,
            validFrom: "2026-08-01",
            validTo: null,
          },
        ],
        provisional: false,
      });
      const transaction = await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        kind: "purchase",
        amount: 25,
        status: "posted",
        transactionDate,
        postedDate: "2026-09-03",
        merchant: "Synthetic store",
        sourceRefs: [
          { source: "synthetic-bank", externalId: "synthetic-card-charge" },
        ],
        allocations: [],
      });
      expect(
        await convergeFinancialTransaction(
          ctx.db,
          { transactionId: transaction.output.id },
          ctx.actor,
        ),
      ).not.toMatchObject({
        status: "review_required",
        reason: expect.stringContaining("funding account"),
      });
    },
  );

  it("still refuses a household-funded card the member neither owns nor holds", async () => {
    const household = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic household",
      kind: "household",
    });
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic account owner",
      kind: "member",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic other card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: owner.output.id,
      fundingPeriods: [
        {
          ledgerPartyId: household.output.id,
          validFrom: "2026-08-01",
          validTo: null,
        },
      ],
      provisional: false,
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      amount: 25,
      status: "posted",
      transactionDate: "2026-09-01",
      postedDate: "2026-09-03",
      merchant: "Synthetic store",
      sourceRefs: [
        { source: "synthetic-bank", externalId: "synthetic-other-charge" },
      ],
      allocations: [],
    });
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        { transactionId: transaction.output.id },
        ctx.actor,
      ),
    ).toMatchObject({
      status: "review_required",
      reason: expect.stringContaining("funding account"),
    });
  });

  // A newly accepted Email adds a source ref after booking. Replay must keep
  // that verified provenance without blessing unrelated edits to booked money.
  it("replays automatic booking after adding a later exact financial Email", async () => {
    const { transaction, purchase, vendor, account } = await fixture();
    const input = { transactionId: transaction.output.id };
    expect(
      await convergeFinancialTransaction(ctx.db, input, ctx.actor),
    ).toMatchObject({ status: "applied", purchaseId: purchase.output.id });
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic financial-mail member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await getDb(ctx.db)
      .update(vendorTable)
      .set({
        website: "https://example.com",
        orderEmailSenders: ["orders@example.com"],
      })
      .where(eq(vendorTable.id, vendor.entityId));
    const checksum = "d".repeat(64);
    const [original] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: member.id,
        rawChecksum: checksum,
        content: {
          snippet: null,
          bodyText:
            "Payment ID SYN-PAY-LATER. Paid $25.00 USD from Synthetic cash to Synthetic store on 2026-09-01.",
          bodyHtml: null,
          headers: {},
        },
      })
      .returning();
    if (!original) throw new Error("Synthetic original missing");
    const email = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: member.id,
      mailboxId: "synthetic-later-finance",
      messageId: "synthetic-later-payment",
      orderMailId: original.id,
      checksum,
      classification: "related",
      status: "completed",
    });
    const decide: DecisionPort = async () => ({
      answers: {
        selection: {
          type: "choice",
          choice: "c0",
          confidence: 0.99,
          probabilities: { c0: 0.99, c1: 0.005, c2: 0.005 },
        },
      },
    });
    const prepared = await prepareMailFinancialEvent(
      ctx.db,
      { emailId: parseEntityId("email", email.id) },
      ctx.actor,
      {
        decide,
        extract: async () => ({
          kind: "purchase_payment",
          confidence: "high",
          amountText: "$25.00",
          currency: "USD",
          sourceAccountLabel: "Synthetic cash",
          providerEventId: "SYN-PAY-LATER",
          occurredOn: "2026-09-01",
          counterpartyLabel: "Synthetic store",
        }),
      },
    );
    if (prepared.status !== "verified") throw new Error(prepared.reason);
    await getDb(ctx.db)
      .insert(emailFinancialAssociation)
      .values({
        emailId: parseEntityId("email", email.id),
        evidenceChecksum: checksum,
        transactionId: transaction.entityId,
        reviewedAccountId: account.entityId,
        sourceAccountLabel: "Synthetic cash",
        reviewReason:
          "Synthetic member accepted this exact later payment mapping",
        decidedByUserId: ctx.actor.userId,
      });
    expect(
      (await settlementRefsFor(ctx.db, [transaction.entityId])).get(
        transaction.entityId,
      ),
    ).toEqual([{ source: "synthetic-bank", externalId: "synthetic-charge-1" }]);
    const withEmail = { ...input, emailId: email.shortcode };
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        withEmail,
        ctx.actor,
        prepared.preparation,
      ),
    ).toMatchObject({
      status: "already_recorded",
      purchaseId: purchase.output.id,
    });
    expect(
      (await settlementRefsFor(ctx.db, [transaction.entityId])).get(
        transaction.entityId,
      ),
    ).toContainEqual({
      source: "financial-mail",
      externalId: expect.any(String),
    });
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        withEmail,
        ctx.actor,
        prepared.preparation,
      ),
    ).toMatchObject({
      status: "already_recorded",
      purchaseId: purchase.output.id,
    });
    expect(await liveCosts()).toEqual([{ cost: 25 }]);
    await getDb(ctx.db)
      .update(expense)
      .set({ cost: 30 })
      .where(eq(expense.bookingTransactionCode, transaction.output.id));
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        withEmail,
        ctx.actor,
        prepared.preparation,
      ),
    ).toMatchObject({
      status: "review_required",
      reason: expect.stringContaining("Accepted booking facts changed"),
    });
    expect(await liveCosts()).toEqual([{ cost: 30 }]);
  });
  it("attaches settlement to itemization without another Expense", async () => {
    const { transaction, purchase } = await fixture();
    await createRepoEntity(ctx, "expense", {
      purchaseId: purchase.output.id,
      name: "Synthetic receipt",
      cost: 25,
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
    });
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        { transactionId: transaction.output.id },
        ctx.actor,
      ),
    ).toMatchObject({ status: "applied", expenseId: null });
    expect(await liveCosts()).toEqual([{ cost: 25 }]);
    await getDb(ctx.db)
      .update(expense)
      .set({ cost: 27 })
      .where(eq(expense.purchaseId, purchase.entityId));
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        { transactionId: transaction.output.id },
        ctx.actor,
      ),
    ).toMatchObject({ status: "review_required" });
    expect(await liveCosts()).toEqual([{ cost: 27 }]);
  });
  it("does not promote a sole same-amount nearby Purchase to identity proof", async () => {
    const { transaction } = await fixture("purchase", false);
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        { transactionId: transaction.output.id },
        ctx.actor,
      ),
    ).toMatchObject({ status: "review_required" });
    expect(await liveCosts()).toEqual([]);
  });
  // Even an accepted allocation cannot let finance.converge cross the Vendor
  // selected by this history Run or fall back to the approval's other Vendors.
  it("keeps transfer evidence out of the spending ledger", async () => {
    const { transaction } = await fixture("account_transfer", false);
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        { transactionId: transaction.output.id },
        ctx.actor,
      ),
    ).toMatchObject({ status: "review_required" });
    expect(await liveCosts()).toEqual([]);
  });
  it("requires an accepted cross-provider mapping before reusing a provider id", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic card 0000",
      identity: { kind: "cash" },
      ledgerPartyId: party.shortcode,
      provisional: false,
    });
    await createRepoEntity(ctx, "vendor", {
      name: "Synthetic hardware",
      website: "https://example.com",
      orderEmailSenders: ["orders@example.com"],
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      amount: 42.5,
      status: "posted",
      transactionDate: "2026-09-01",
      postedDate: "2026-09-03",
      merchant: "Synthetic processor",
      sourceRefs: [
        { source: "synthetic-provider", externalId: "SYN-PAY-1001" },
      ],
    });
    const decide: DecisionPort = async () => ({
      answers: {
        selection: {
          type: "choice",
          choice: "c0",
          confidence: 0.99,
          probabilities: { c0: 0.99, c1: 0.005, c2: 0.005 },
        },
      },
    });
    async function message(messageId: string, checksum: string) {
      const [original] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          rawChecksum: checksum,
          content: {
            snippet: null,
            bodyText:
              "Payment ID SYN-PAY-1001. Paid $42.50 USD from Synthetic card 0000 to Synthetic hardware on 2026-09-01.",
            bodyHtml: null,
            headers: {},
          },
        })
        .returning();
      if (!original) throw new Error("Synthetic original missing");
      const email = await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-finance",
        messageId,
        orderMailId: original.id,
        checksum,
        classification: "related",
        status: "completed",
      });
      const prepared = await prepareMailFinancialEvent(
        ctx.db,
        { emailId: parseEntityId("email", email.id) },
        ctx.actor,
        {
          decide,
          extract: async () => ({
            kind: "purchase_payment",
            confidence: "high",
            amountText: "$42.50",
            currency: "USD",
            sourceAccountLabel: "Synthetic card 0000",
            providerEventId: "SYN-PAY-1001",
            occurredOn: "2026-09-01",
            counterpartyLabel: "Synthetic hardware",
          }),
        },
      );
      if (prepared.status !== "verified") throw new Error(prepared.reason);
      return { email, prepared: prepared.preparation };
    }
    const first = await message(
      "synthetic-payment-confirmation",
      "a".repeat(64),
    );
    const input = {
      transactionId: transaction.output.id,
      emailId: first.email.shortcode,
    };
    const duplicate = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      amount: 42.5,
      status: "posted",
      transactionDate: "2026-09-02",
      postedDate: "2026-09-04",
      sourceRefs: [
        { source: "synthetic-second-bank", externalId: "SYN-PAY-1001" },
      ],
    });
    // The same unqualified payment id belongs to a different provider. Neither
    // that collision nor an identity minted after booking establishes a mapping.
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        input,
        ctx.actor,
        first.prepared,
      ),
    ).toMatchObject({ status: "review_required" });
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        { transactionId: duplicate.output.id, emailId: first.email.shortcode },
        ctx.actor,
        first.prepared,
      ),
    ).toMatchObject({ status: "review_required" });
    expect(await liveCosts()).toEqual([]);
    const acceptMapping = (mail: typeof first) =>
      getDb(ctx.db)
        .insert(emailFinancialAssociation)
        .values({
          emailId: parseEntityId("email", mail.email.id),
          evidenceChecksum: mail.prepared.checksum,
          transactionId: transaction.entityId,
          reviewedAccountId: account.entityId,
          sourceAccountLabel: "Synthetic card 0000",
          reviewReason:
            "Synthetic member accepted this exact cross-provider payment mapping",
          decidedByUserId: ctx.actor.userId,
        });
    await acceptMapping(first);
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        input,
        ctx.actor,
        first.prepared,
      ),
    ).toMatchObject({ status: "applied" });
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        input,
        ctx.actor,
        first.prepared,
      ),
    ).toMatchObject({ status: "already_recorded" });
    const second = await message("synthetic-payment-receipt", "b".repeat(64));
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        {
          transactionId: transaction.output.id,
          emailId: second.email.shortcode,
        },
        ctx.actor,
        second.prepared,
      ),
    ).toMatchObject({ status: "review_required" });
    expect(await liveCosts()).toEqual([{ cost: 42.5 }]);
    await acceptMapping(second);
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        {
          transactionId: transaction.output.id,
          emailId: second.email.shortcode,
        },
        ctx.actor,
        second.prepared,
      ),
    ).toMatchObject({ status: "already_recorded" });
    expect(await liveCosts()).toEqual([{ cost: 42.5 }]);
    const associations = await getDb(ctx.db)
      .select()
      .from(emailFinancialAssociation)
      .where(eq(emailFinancialAssociation.transactionId, transaction.entityId));
    expect(associations).toHaveLength(2);
    // A duplicate wallet/bank observation cannot spend the same provider event again.
    expect(
      await convergeFinancialTransaction(
        ctx.db,
        { transactionId: duplicate.output.id, emailId: second.email.shortcode },
        ctx.actor,
        second.prepared,
      ),
    ).toMatchObject({ status: "review_required" });
    expect(await liveCosts()).toEqual([{ cost: 42.5 }]);
  });
  it("replays automatic booking after exact itemization adds the later order identity", async () => {
    const { transaction, purchase, vendor } = await fixture();
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic receipt member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const input = { transactionId: transaction.output.id };
    const booked = await convergeFinancialTransaction(ctx.db, input, ctx.actor);
    if (booked.status !== "applied" || !booked.expenseId)
      throw new Error("Expected one automatically booked aggregate");
    const candidate: ExtractedOrderCandidate = {
      orderId: "SYNTHETIC-LATER-ORDER",
      orderedAt: "2026-09-01T12:00:00Z",
      merchant: "Synthetic store",
      currency: "USD",
      printedGrandTotal: 25,
      lines: [
        { title: "Synthetic first service", amount: 10, lineKind: "principal" },
        {
          title: "Synthetic second service",
          amount: 15,
          lineKind: "principal",
        },
      ],
      payments: [],
      allShipmentsDelivered: false,
    };
    await memberImport(ctx.db, ctx.actor, {
      key: "synthetic-later-order",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "synthetic-itemization",
          vendorId: vendor.output.id,
          targetPurchaseId: purchase.output.id,
          source: {
            kind: "vendor_export",
            externalKey: "synthetic:later-order",
            checksum: "c".repeat(64),
          },
          extraction: { status: "ready", candidate },
        },
      ],
    });
    const finding = await getDb(ctx.db).query.runFinding.findFirst({
      where: eq(runFinding.entityId, purchase.entityId),
    });
    if (!finding)
      throw new Error("Expected exact aggregate replacement finding");
    const preview = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding.id,
        resolution: {
          kind: "replace_lines",
          expenseIds: [booked.expenseId],
          lines: candidate.lines.map((_, lineIndex) => ({
            lineIndex,
            expenseId: booked.expenseId,
            productId: null,
          })),
        },
      },
      ctx.actor,
    );
    await resolveRunFinding(
      ctx.db,
      {
        id: finding.id,
        action: "apply",
        reviewedFingerprint: preview.reviewedFingerprint,
      },
      ctx.actor,
    );
    expect(
      await getDb(ctx.db).query.purchase.findFirst({
        where: eq(purchaseTable.id, purchase.entityId),
      }),
    ).toMatchObject({ orderId: candidate.orderId });
    expect(
      (await liveCosts()).map((row) => row.cost).sort((a, b) => a! - b!),
    ).toEqual([10, 15]);
    expect(
      await convergeFinancialTransaction(ctx.db, input, ctx.actor),
    ).toMatchObject({
      status: "already_recorded",
      purchaseId: purchase.output.id,
    });
  });
});
