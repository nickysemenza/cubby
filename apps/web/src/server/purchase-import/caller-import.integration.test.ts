import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  mailboxMessage,
  orderMail,
  orderMailCandidateDecision,
  orderMailEvent,
  purchase,
  run,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { resolveMail } from "./mail-tool";

const mailboxId = "synthetic-mailbox";

// Caller-driven import: a member (or Pi) prepares and commits from a retained
// Email through the public writers, Email dispositions are recorded through
// `mail.resolve`, and nothing launches unattended Product research.
describe("caller-driven purchase import", () => {
  const ctx = withTestDb();

  async function fixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Caller import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic garden shop",
      website: "https://shop.example",
    });
    return { party, vendor };
  }

  async function retainedMail(
    partyId: string,
    messageId: string,
    bodyText: string,
    checksumDigit: string,
  ) {
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: partyId,
        mailboxId,
        messageId,
        sender: "orders@shop.example",
        subject: `Synthetic ${messageId}`,
        receivedAt: new Date("2026-09-20T18:00:00Z"),
        rawChecksum: checksumDigit.repeat(64),
        content: { snippet: null, bodyText, bodyHtml: null },
      })
      .returning();
    if (!mail) throw new Error("Synthetic mail fixture did not persist");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: partyId,
      mailboxId,
      messageId,
      checksum: mail.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-v1",
      status: "pending",
      orderMailId: mail.id,
    });
    return mail;
  }

  async function importConfirmation() {
    const { party, vendor } = await fixture();
    const mail = await retainedMail(
      party.id,
      "confirmation-1",
      "Order SYN-100 confirmed: Synthetic trowel $18.50",
      "a",
    );
    const prepared = await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: {
          operationId: "prepare:syn-100",
          itemOperationIds: ["prepare-item:syn-100"],
        },
        orders: [
          {
            vendorId: vendor.shortcode,
            stableOrderId: "syn-100",
            itemOperationId: "prepare-item:syn-100",
            source: {
              kind: "mail_message",
              externalKey: `gmail:${mailboxId}:${mail.messageId}`,
              checksum: mail.rawChecksum,
            },
            evidenceChecksum: mail.rawChecksum,
            extractionRevision: "synthetic@1",
            extraction: {
              status: "ready",
              candidate: {
                orderId: "SYN-100",
                orderedAt: "2026-09-20T12:00:00.000Z",
                merchant: "Synthetic garden shop",
                currency: "USD",
                printedGrandTotal: 18.5,
                lines: [
                  {
                    title: "Synthetic trowel",
                    amount: 18.5,
                    lineKind: "principal",
                  },
                ],
                payments: [],
                allShipmentsDelivered: false,
              },
            },
            lineIds: ["syn-100:line-1"],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
      ctx.actor,
    );
    const commitInput = {
      _runExecution: { run: prepared.runId, operationId: "commit:syn-100" },
      prepareOperationId: "prepare:syn-100",
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "syn-100",
          stableLineId: "syn-100:line-1",
          resolution: { kind: "new" as const },
        },
      ],
    };
    const committed = await commitPurchaseImport(
      ctx.db,
      commitInput,
      ctx.actor,
    );
    return { party, vendor, mail, prepared, commitInput, committed };
  }

  it("imports a retained Email for a member without a Run and launches no research", async () => {
    const { mail, prepared, commitInput, committed } =
      await importConfirmation();

    const runs = await getDb(ctx.db)
      .select({ shortcode: run.shortcode, purpose: run.purpose })
      .from(run);
    // Absent caller: the member's import is the only Run; no Product research
    // or other follow-on work was launched by the commit.
    expect(runs).toEqual([
      { shortcode: prepared.runId, purpose: "file_import" },
    ]);

    const replay = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(replay).toEqual(committed);
    const purchaseId = committed.items[0]?.purchaseId;
    expect(purchaseId).toBeTruthy();

    // A mail-sourced commit records its confirmation link itself.
    const links = await getDb(ctx.db)
      .select({
        event: orderMailEvent.event,
        decision: orderMailCandidateDecision.decision,
        purchaseShortcode: purchase.shortcode,
      })
      .from(orderMailEvent)
      .innerJoin(
        orderMailCandidateDecision,
        eq(orderMailCandidateDecision.eventId, orderMailEvent.id),
      )
      .innerJoin(
        purchase,
        eq(purchase.id, orderMailCandidateDecision.purchaseId),
      )
      .where(eq(orderMailEvent.orderMailId, mail.id));
    expect(links).toEqual([
      {
        event: "confirmation",
        decision: "linked",
        purchaseShortcode: purchaseId,
      },
    ]);
    const [message] = await getDb(ctx.db)
      .select({ status: mailboxMessage.status })
      .from(mailboxMessage)
      .where(eq(mailboxMessage.messageId, mail.messageId));
    expect(message?.status).toBe("completed");
  });

  it("links a shipment Email to an existing Purchase without new Expenses, idempotently", async () => {
    const { party, committed } = await importConfirmation();
    const purchaseId = committed.items[0]!.purchaseId!;
    const shipment = await retainedMail(
      party.id,
      "shipment-1",
      "Order SYN-100 has shipped",
      "c",
    );
    const expensesBefore = await getDb(ctx.db)
      .select({ id: expense.id })
      .from(expense);

    const input = {
      mailboxId,
      messageId: shipment.messageId,
      checksum: shipment.rawChecksum,
      disposition: {
        kind: "linked" as const,
        purchaseId,
        event: "shipped" as const,
      },
    };
    const first = await resolveMail(ctx.db, input, ctx.actor);
    const replay = await resolveMail(ctx.db, input, ctx.actor);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ status: "completed", purchaseId });

    const events = await getDb(ctx.db)
      .select({ event: orderMailEvent.event })
      .from(orderMailEvent)
      .where(eq(orderMailEvent.orderMailId, shipment.id));
    expect(events).toEqual([{ event: "shipped" }]);
    expect(
      await getDb(ctx.db).select({ id: expense.id }).from(expense),
    ).toEqual(expensesBefore);
  });

  it("refuses a changed Email and disposes of an unrelated one", async () => {
    const { party } = await fixture();
    const newsletter = await retainedMail(
      party.id,
      "newsletter-1",
      "Synthetic newsletter with no purchase",
      "d",
    );
    await expect(
      resolveMail(
        ctx.db,
        {
          mailboxId,
          messageId: newsletter.messageId,
          checksum: "e".repeat(64),
          disposition: { kind: "unrelated", reason: "Marketing only" },
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/changed/i);

    const resolved = await resolveMail(
      ctx.db,
      {
        mailboxId,
        messageId: newsletter.messageId,
        checksum: newsletter.rawChecksum,
        disposition: { kind: "unrelated", reason: "Marketing only" },
      },
      ctx.actor,
    );
    expect(resolved).toMatchObject({ status: "completed", purchaseId: null });
    // No readable copy of unrelated mail survives the disposition.
    expect(
      await getDb(ctx.db)
        .select({ id: orderMail.id })
        .from(orderMail)
        .where(eq(orderMail.id, newsletter.id)),
    ).toEqual([]);
    const [message] = await getDb(ctx.db)
      .select({
        classification: mailboxMessage.classification,
        orderMailId: mailboxMessage.orderMailId,
      })
      .from(mailboxMessage)
      .where(
        and(
          eq(mailboxMessage.mailboxId, mailboxId),
          eq(mailboxMessage.messageId, newsletter.messageId),
        ),
      );
    expect(message).toEqual({ classification: "unrelated", orderMailId: null });
  });
});
