import { purchaseId } from "@cubby/schemas/identifiers";
import { purchaseShortcode, SHORTCODE_CHARS } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
/**
 * Mail matching failure modes: an exact order can be dismissed, the dismissal
 * survives rereads, and a later explicit link replaces it without creating a
 * Purchase or changing spend.
 */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  importSourceClaim,
  importSourceOrder,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
  purchase as purchaseTable,
  vendorAccount,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { buildEntityReport } from "~/server/repo/entity-report";
import { mergePurchases } from "~/server/repo/purchase";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { syntheticRetainedMail } from "./retained-mail.fixtures";
import {
  decideOrderMailCandidate,
  listPurchaseOrderMail,
  listVendorOrderMail,
} from "./review";

describe("Vendor order mail review", () => {
  const ctx = withTestDb();

  it.each(["accepted_alias", "accepted_attachment"] as const)(
    "shows owned content-cleared %s evidence in both Vendor and Purchase views",
    async (sourceKind) => {
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic accepted evidence member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic accepted evidence merchant",
      });
      const account = await insertWithShortcode(ctx.db, "vendorAccount", {
        label: "Synthetic accepted evidence account",
        vendorId: vendor.id,
        ledgerPartyId: party.id,
      });
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        vendorAccountId: account.id,
      });
      const scope = await insertWithShortcode(ctx.db, "run", {
        purpose: "mail_import",
        trigger: "manual",
        status: "running",
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: party.name,
        actorEmail: "accepted-review@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: party.kind,
      });
      const original = await syntheticRetainedMail(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-accepted-review-mailbox",
        messageId: "synthetic-accepted-review-message",
        sender: null,
        subject: null,
        receivedAt: null,
        vendorId: null,
        rawChecksum: "e".repeat(64),
        content: { snippet: null, bodyText: null, bodyHtml: null },
      });
      await getDb(ctx.db)
        .update(emailTable)
        .set({
          classification: "unrelated",
          status: "completed",
          contentClearedAt: new Date("2026-10-01T12:00:00Z"),
        })
        .where(eq(emailTable.orderMailId, original.id));
      const kind =
        sourceKind === "accepted_attachment"
          ? "mail_attachment"
          : "mail_message";
      const attachmentKey = "synthetic-accepted-attachment";
      const externalKey = `gmail:${original.mailboxId}:${original.messageId}${
        sourceKind === "accepted_attachment"
          ? `:attachment:${attachmentKey}`
          : ""
      }`;
      const checksum = "f".repeat(64);
      if (sourceKind === "accepted_attachment")
        await getDb(ctx.db).insert(orderMailAttachment).values({
          orderMailId: original.id,
          providerAttachmentId: attachmentKey,
          filename: "synthetic-evidence.pdf",
          mimeType: "application/pdf",
          checksum,
          pendingObjectKey: null,
        });
      const [root] = await getDb(ctx.db)
        .insert(importSourceClaim)
        .values({
          ledgerPartyId: party.id,
          kind,
          externalKey,
          checksum,
          firstRunId: scope.id,
          lastRunId: scope.id,
        })
        .returning();
      if (!root) throw new Error("Synthetic accepted root claim missing");
      const [acceptedClaim] =
        sourceKind === "accepted_alias"
          ? await getDb(ctx.db)
              .insert(importSourceClaim)
              .values({
                ledgerPartyId: party.id,
                kind,
                externalKey: "synthetic:historical-accepted-alias",
                canonicalClaimId: root.id,
                checksum,
                firstRunId: scope.id,
                lastRunId: scope.id,
              })
              .returning()
          : [root];
      if (!acceptedClaim)
        throw new Error("Synthetic accepted family claim missing");
      const acceptedAt = new Date("2026-10-02T12:00:00Z");
      await getDb(ctx.db).insert(importSourceOrder).values({
        sourceClaimId: acceptedClaim.id,
        orderKey: "synthetic-accepted-review-order",
        purchaseId: purchase.id,
        checksum,
        outputFingerprint: "synthetic-accepted-review-fingerprint",
        createdAt: acceptedAt,
      });
      const foreignParty = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic foreign evidence member",
        kind: "member",
      });
      await syntheticRetainedMail(ctx.db, {
        ...original,
        id: undefined,
        ledgerPartyId: foreignParty.id,
      });
      const [foreignClaim] = await getDb(ctx.db)
        .insert(importSourceClaim)
        .values({
          ledgerPartyId: foreignParty.id,
          kind: "mail_message",
          externalKey: `gmail:${original.mailboxId}:${original.messageId}`,
          checksum: "c".repeat(64),
          firstRunId: scope.id,
          lastRunId: scope.id,
        })
        .returning();
      if (!foreignClaim)
        throw new Error("Synthetic foreign source claim missing");
      await getDb(ctx.db)
        .insert(importSourceOrder)
        .values({
          sourceClaimId: foreignClaim.id,
          orderKey: "synthetic-foreign-review-order",
          purchaseId: purchase.id,
          checksum: "c".repeat(64),
          outputFingerprint: "synthetic-foreign-review-fingerprint",
        });
      const before = await reviewSourceState();
      const vendorMail = await listVendorOrderMail(ctx.db, {
        vendorId: vendor.shortcode,
      });
      const purchaseMail = await listPurchaseOrderMail(ctx.db, {
        purchaseId: purchase.shortcode,
      });
      const expected = [
        expect.objectContaining({
          messageId: original.messageId,
          ledgerPartyId: party.shortcode,
          sender: null,
          subject: null,
          receivedAt: null,
          associations: [
            {
              purchaseId: purchase.shortcode,
              evidenceChecksum: checksum,
              acceptedAt: acceptedAt.toISOString(),
            },
          ],
          events: [],
        }),
      ];
      expect(vendorMail.items).toEqual(expected);
      expect(purchaseMail.items).toEqual(expected);
      expect(
        (
          await listVendorOrderMail(ctx.db, {
            vendorId: vendor.shortcode,
            ledgerPartyId: foreignParty.shortcode,
          })
        ).items,
      ).toEqual([]);
      expect(await reviewSourceState()).toEqual(before);
    },
  );

  async function reviewSourceState() {
    return {
      emails: await getDb(ctx.db).select().from(emailTable),
      originals: await getDb(ctx.db).select().from(orderMail),
      attachments: await getDb(ctx.db).select().from(orderMailAttachment),
      claims: await getDb(ctx.db).select().from(importSourceClaim),
      accepted: await getDb(ctx.db).select().from(importSourceOrder),
    };
  }

  it.each(["deleted", "excluded"] as const)(
    "retains owned %s processing history and shell identity after content disposal",
    async (status) => {
      const f = await retainedReviewFixture();
      const updatedAt = new Date("2026-10-02T13:00:00Z");
      await getDb(ctx.db)
        .update(emailTable)
        .set({
          classification: "related",
          classificationVersion: "synthetic-classifier/v1",
          status,
          runId: f.runId,
          updatedAt,
          contentClearedAt: updatedAt,
        })
        .where(eq(emailTable.orderMailId, f.source.id));
      const result = await listVendorOrderMail(ctx.db, {
        vendorId: f.vendor.shortcode,
      });
      const item = result.items.find(
        (row) => row.messageId === f.source.messageId,
      );
      expect(item?.processing).toMatchObject({
        status,
        updatedAt: updatedAt.toISOString(),
      });
      expect(item?.researchRun).toMatchObject({
        status: "needs_review",
        sourceStatus: status,
      });
    },
  );

  // Mail processing is not Purchase linking or Product verification. Its clock
  // comes from the exact owned mailbox ledger, never email receipt time.
  it("shows owned mail processing separately from accepted sources and reviewed links", async () => {
    const f = await retainedReviewFixture();
    const updatedAt = new Date("2026-10-02T13:00:00Z");
    await getDb(ctx.db)
      .update(emailTable)
      .set({
        classification: "uncertain",
        classificationVersion: "synthetic-classifier/v1",
        status: "blocked",
        runId: f.runId,
        updatedAt,
      })
      .where(eq(emailTable.orderMailId, f.source.id));
    const other = await syntheticRetainedMail(ctx.db, {
      ...f.source,
      id: undefined,
      mailboxId: "synthetic-other-mailbox",
      vendorId: null,
    });
    await getDb(ctx.db)
      .update(emailTable)
      .set({
        classification: "related",
        classificationVersion: "synthetic-wrong-ledger/v1",
        status: "completed",
        updatedAt: new Date("2026-10-03T13:00:00Z"),
      })
      .where(eq(emailTable.orderMailId, other.id));
    const decidedAt = new Date("2026-10-02T14:00:00Z");
    await getDb(ctx.db).insert(orderMailCandidateDecision).values({
      eventId: f.event.id,
      purchaseId: f.purchase.id,
      decision: "linked",
      evidenceChecksum: f.source.rawChecksum,
      decidedByUserId: ctx.actor.userId,
      updatedAt: decidedAt,
    });
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: f.source.ledgerPartyId,
        kind: "mail_message",
        externalKey: `gmail:${f.source.mailboxId}:${f.source.messageId}`,
        checksum: f.source.rawChecksum,
        firstRunId: f.runId,
        lastRunId: f.runId,
      })
      .returning();
    if (!claim) throw new Error("Synthetic accepted mail claim missing");
    const acceptedAt = new Date("2026-10-02T15:00:00Z");
    await getDb(ctx.db).insert(importSourceOrder).values({
      sourceClaimId: claim.id,
      orderKey: "synthetic-accepted-order",
      purchaseId: f.purchase.id,
      checksum: f.source.rawChecksum,
      outputFingerprint: "synthetic-accepted-mail",
      createdAt: acceptedAt,
    });
    const report = await buildEntityReport(
      ctx.db,
      { slot: "purchase.order-mail", id: f.purchase.shortcode },
      async () => null,
      ctx.actor,
    );
    const rows = report.blocks.flatMap((block) =>
      block.kind === "records" ? block.rows : [],
    );
    const original = rows.find((row) => row.title === f.source.subject);
    expect(original?.at).toBe(f.source.receivedAt?.toISOString());
    expect(original?.statuses).toEqual(
      expect.arrayContaining([
        { label: "Classification: uncertain" },
        { label: "Processing: blocked" },
      ]),
    );
    expect(original?.detail?.text).toContain(updatedAt.toISOString());
    expect(original?.detail?.text).toContain("synthetic-classifier/v1");
    expect(original?.detail?.text).not.toContain("synthetic-wrong-ledger/v1");
    const linked = rows.find((row) =>
      row.statuses?.some((status) => status.label === "Linked"),
    );
    expect(linked?.at).toBe(decidedAt.toISOString());
    expect(linked?.id).toBe(f.purchase.shortcode);
    const accepted = rows.find((row) =>
      row.statuses?.some((status) => status.label === "Accepted source"),
    );
    expect(accepted?.at).toBe(acceptedAt.toISOString());
    expect(accepted?.id).toBe(f.purchase.shortcode);
    expect(
      rows.some((row) =>
        row.statuses?.some((status) => status.label === "Verified"),
      ),
    ).toBe(false);
  });

  // Accepted source associations, not a nullable sender hint or order-id coincidence,
  // must make a multi-merchant original readable on every supported Purchase.
  it("shows accepted multiVendor mail with no vendor hint on each related Vendor and Purchase", async () => {
    const f = await retainedReviewFixture();
    const secondVendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic second receipt merchant",
    });
    const secondPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: secondVendor.id,
      orderId: null,
    });
    await getDb(ctx.db)
      .update(orderMail)
      .set({ vendorId: null })
      .where(eq(orderMail.id, f.source.id));
    await getDb(ctx.db)
      .update(emailTable)
      .set({ receivedAt: null })
      .where(eq(emailTable.orderMailId, f.source.id));
    const [secondEvent] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: f.source.id,
        event: "cancelled",
        sourceKey: "synthetic-second-merchant-event",
      })
      .returning();
    if (!secondEvent) throw new Error("Synthetic second event missing");
    await getDb(ctx.db)
      .insert(orderMailCandidateDecision)
      .values([
        {
          eventId: f.event.id,
          purchaseId: f.purchase.id,
          decision: "linked",
          evidenceChecksum: f.source.rawChecksum,
          decidedByUserId: ctx.actor.userId,
        },
        {
          eventId: secondEvent.id,
          purchaseId: secondPurchase.id,
          decision: "linked",
          evidenceChecksum: f.source.rawChecksum,
          decidedByUserId: ctx.actor.userId,
        },
      ]);
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: f.source.ledgerPartyId,
        kind: "mail_message",
        externalKey: `gmail:${f.source.mailboxId}:${f.source.messageId}`,
        checksum: f.source.rawChecksum,
        firstRunId: f.runId,
        lastRunId: f.runId,
      })
      .returning();
    if (!claim) throw new Error("Synthetic multi-merchant source missing");
    await getDb(ctx.db)
      .insert(importSourceOrder)
      .values(
        [f.purchase, secondPurchase].map((p) => ({
          sourceClaimId: claim.id,
          orderKey: p.id,
          purchaseId: p.id,
          checksum: f.source.rawChecksum,
          outputFingerprint: `synthetic-accepted-${p.id}`,
        })),
      );
    for (const p of [f.purchase, secondPurchase]) {
      const relatedVendor = p === f.purchase ? f.vendor : secondVendor;
      const vendorMail = await listVendorOrderMail(ctx.db, {
        vendorId: relatedVendor.shortcode,
      });
      const purchaseMail = await listPurchaseOrderMail(ctx.db, {
        purchaseId: p.shortcode,
      });
      expect(vendorMail.items.map((mail) => mail.messageId)).toEqual([
        f.source.messageId,
      ]);
      expect(
        purchaseMail.items[0]?.events.flatMap((event) => event.candidates),
      ).toEqual([
        expect.objectContaining({
          purchaseId: p.shortcode,
          decision: "linked",
        }),
      ]);
      const report = await buildEntityReport(
        ctx.db,
        { slot: "purchase.order-mail", id: p.shortcode },
        async () => null,
        ctx.actor,
      );
      const rows = report.blocks.flatMap((block) =>
        block.kind === "records" ? block.rows : [],
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          title: f.source.subject,
          trailing: "Unknown date",
          externalLink: expect.objectContaining({
            url: expect.stringContaining(
              encodeURIComponent(f.source.messageId),
            ),
          }),
        }),
      );
      const originalRow = rows.find((row) => row.title === f.source.subject);
      expect(originalRow?.at).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain("1970");
    }
    const [unchanged] = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.id, f.source.id));
    expect(unchanged?.vendorId).toBeNull();
  });

  async function retainedReviewFixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic retention reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic retained receipt maker",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "SYNTHETIC-RETAINED",
    });
    const scope = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      ledgerPartyId: party.id,
      trigger: "manual",
      status: "needs_review",
      actorUserId: ctx.actor.userId,
      actorName: party.name,
      actorEmail: "retention-review@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
    });
    const checksum = "e".repeat(64);
    const source = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-retention-mailbox",
      vendorId: vendor.id,
      messageId: "synthetic-retention-message",
      sender: "receipts@retention.example.test",
      subject: "Synthetic retained receipt",
      receivedAt: new Date("2026-10-01T12:00:00Z"),
      rawChecksum: checksum,
      content: {
        bodyText: "Synthetic original retained receipt",
        bodyHtml: null,
        snippet: null,
      },
    });
    if (!source) throw new Error("Synthetic retained source missing");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: source.id,
        event: "placed",
        orderId: "SYNTHETIC-RETAINED",
        sourceKey: "synthetic-retention-event",
      })
      .returning();
    if (!event) throw new Error("Synthetic retained event missing");
    const decision = {
      eventId: event.id,
      purchaseId: purchase.shortcode,
      decision: "linked" as const,
      evidenceChecksum: checksum,
    };
    return { source, event, purchase, vendor, decision, runId: scope.id };
  }

  it("links a member reviewed retained original without requiring a vendor hint", async () => {
    const f = await retainedReviewFixture();
    await getDb(ctx.db)
      .update(orderMail)
      .set({ vendorId: null })
      .where(eq(orderMail.id, f.source.id));
    await decideOrderMailCandidate(ctx.db, f.decision, ctx.actor);
    const decisions = await getDb(ctx.db)
      .select()
      .from(orderMailCandidateDecision)
      .where(eq(orderMailCandidateDecision.eventId, f.event.id));
    expect(decisions).toEqual([
      expect.objectContaining({
        purchaseId: f.purchase.id,
        decision: "linked",
        evidenceChecksum: f.source.rawChecksum,
      }),
    ]);
    const [unchanged] = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.id, f.source.id));
    expect(unchanged?.vendorId).toBeNull();
  });

  it("keeps exact matches reviewable and honors a durable dismiss or link", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Trail Shop",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "TS-SYN-1001",
      date: "2026-09-10",
      statedTotal: 48,
    });
    const bodyText =
      "Order TS-SYN-1001. Example Trail Shop. Printed total 48 USD.";
    const checksum = await sha256Hex(bodyText);
    const mail = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: `synthetic-review-${party.id}`,
      content: { bodyText, bodyHtml: null, snippet: null },
      vendorId: vendor.id,
      messageId: "review-mail-1",
      threadId: "review-thread-1",
      sender: "Example Trail Shop <orders@example.test>",
      subject: "Order update",
      receivedAt: new Date("2026-09-10T15:00:00.000Z"),
      rawChecksum: checksum,
    });
    if (!mail) throw new Error("test setup: mail missing");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "placed",
        orderId: "TS-SYN-1001",
        amount: 48,
        currency: "USD",
        sourceKey: `classified:${checksum}:0`,
      })
      .returning({ id: orderMailEvent.id });
    if (!event) throw new Error("test setup: event missing");

    const input = {
      vendorId: vendor.shortcode,
      ledgerPartyId: party.shortcode,
    };
    expect(
      (
        await listVendorOrderMail(ctx.db, input, {
          messageIds: ["review-mail-1"],
        })
      ).items,
    ).toHaveLength(1);
    expect(
      (await listVendorOrderMail(ctx.db, input)).items[0]?.events[0]
        ?.candidates[0],
    ).toMatchObject({
      purchaseId: purchase.shortcode,
      reason: "exact_order_id",
      decision: null,
    });

    await decideOrderMailCandidate(
      ctx.db,
      {
        eventId: event.id,
        purchaseId: purchase.shortcode,
        decision: "dismissed",
        evidenceChecksum: checksum,
      },
      ctx.actor,
    );
    expect(
      (await listVendorOrderMail(ctx.db, input)).items[0]?.events[0]
        ?.candidates[0]?.decision,
    ).toBe("dismissed");

    await decideOrderMailCandidate(
      ctx.db,
      {
        eventId: event.id,
        purchaseId: purchase.shortcode,
        decision: "linked",
        evidenceChecksum: checksum,
      },
      ctx.actor,
    );
    expect(
      (await listVendorOrderMail(ctx.db, input)).items[0]?.events[0]
        ?.candidates[0]?.decision,
    ).toBe("linked");
    const [account] = await getDb(ctx.db)
      .select({
        id: vendorAccount.id,
      })
      .from(vendorAccount)
      .where(eq(vendorAccount.vendorId, vendor.id));
    const [linkedPurchase] = await getDb(ctx.db)
      .select({ vendorAccountId: purchaseTable.vendorAccountId })
      .from(purchaseTable)
      .where(eq(purchaseTable.id, purchase.id));
    expect(account).toBeDefined();
    expect(linkedPurchase?.vendorAccountId).toBeNull();
  });

  it("offers Purchases within 45 household days of the mail as nearby candidates", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic window reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Window Shop",
    });
    // 02:00Z on 09-18 is the evening of 09-17 in the household; 08-03 is
    // exactly 45 household days earlier, 08-02 one day too many.
    const edge = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-08-03",
    });
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-08-02",
    });
    const bodyText =
      "Order WS-SYN-2001. Example Window Shop. Printed total 12 USD.";
    const checksum = await sha256Hex(bodyText);
    const mail = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: `synthetic-review-${party.id}`,
      content: { bodyText, bodyHtml: null, snippet: null },
      vendorId: vendor.id,
      messageId: "review-window-mail",
      sender: "Example Window Shop <orders@example.test>",
      subject: "Order update",
      receivedAt: new Date("2026-09-18T02:00:00.000Z"),
      rawChecksum: checksum,
    });
    if (!mail) throw new Error("test setup: mail missing");
    await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "placed",
        orderId: "WS-SYN-2001",
        amount: 12,
        currency: "USD",
        sourceKey: `classified:${checksum}:0`,
      });

    const candidates = (
      await listVendorOrderMail(ctx.db, {
        vendorId: vendor.shortcode,
        ledgerPartyId: party.shortcode,
      })
    ).items[0]?.events[0]?.candidates;
    expect(candidates?.map((candidate) => candidate.purchaseId)).toEqual([
      edge.shortcode,
    ]);
    expect(candidates?.[0]?.reason).toBe("nearby_date");
  });

  it("lets a member's link win over an automatic link committed mid-decision", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic race reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Race Shop",
    });
    const [automatic, chosen] = await Promise.all(
      ["RACE-1", "RACE-2"].map((orderId) =>
        insertWithShortcode(ctx.db, "purchase", {
          vendorId: vendor.id,
          orderId,
          date: "2026-09-10",
        }),
      ),
    );
    const bodyText =
      "Order RACE-1. Example Race Shop. Synthetic original order update.";
    const checksum = await sha256Hex(bodyText);
    const mail = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: `synthetic-review-${party.id}`,
      content: { bodyText, bodyHtml: null, snippet: null },
      vendorId: vendor.id,
      messageId: "race-mail-1",
      sender: "orders@race.example.test",
      subject: "Order update",
      receivedAt: new Date("2026-09-10T15:00:00.000Z"),
      rawChecksum: checksum,
    });
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail!.id,
        event: "placed",
        orderId: "RACE-1",
        currency: "USD",
        sourceKey: `classified:${checksum}:0`,
      })
      .returning({ id: orderMailEvent.id });

    // An automatic link sits uncommitted while the member links elsewhere.
    let commitAutomatic = () => {};
    const held = new Promise<void>((resolve) => {
      commitAutomatic = resolve;
    });
    const automaticLink = withTransaction(ctx.db, async (tx) => {
      await tx.insert(orderMailCandidateDecision).values({
        eventId: event!.id,
        purchaseId: automatic!.id,
        decision: "linked",
        evidenceChecksum: checksum,
        decidedByUserId: "cubby-system",
      });
      await held;
    });
    const memberLink = decideOrderMailCandidate(
      ctx.db,
      {
        eventId: event!.id,
        purchaseId: chosen!.shortcode,
        decision: "linked",
        evidenceChecksum: checksum,
      },
      ctx.actor,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    commitAutomatic();
    await automaticLink;
    await expect(memberLink).resolves.toMatchObject({ decision: "linked" });

    const links = await getDb(ctx.db)
      .select({ purchaseId: orderMailCandidateDecision.purchaseId })
      .from(orderMailCandidateDecision)
      .where(eq(orderMailCandidateDecision.decision, "linked"));
    expect(links).toEqual([{ purchaseId: chosen!.id }]);
  });

  it("retains an older exact order candidate beyond the newest 500 Purchases", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Trail Shop",
    });
    const older = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "TS-OLDER-1001",
      date: "2024-01-01",
    });
    const shortcodes = Array.from({ length: 502 }, (_, index) => {
      let value = index;
      let body = "";
      for (let digit = 0; digit < 4; digit++) {
        body = SHORTCODE_CHARS.charAt(value % SHORTCODE_CHARS.length) + body;
        value = Math.floor(value / SHORTCODE_CHARS.length);
      }
      return purchaseShortcode.parse(`PUR-${body}`);
    }).filter((shortcode) => shortcode !== older.shortcode);
    for (let offset = 0; offset < 501; offset += 100) {
      await getDb(ctx.db)
        .insert(purchaseTable)
        .values(
          Array.from({ length: Math.min(100, 501 - offset) }, (_, index) => {
            const shortcode = shortcodes[offset + index];
            if (!shortcode) throw new Error("test setup: shortcode missing");
            return {
              id: purchaseId.parse(crypto.randomUUID()),
              shortcode,
              vendorId: vendor.id,
              orderId: `TS-NEWER-${offset + index}`,
              date: "2026-09-10",
            };
          }),
        );
    }
    const bodyText =
      "Order TS-OLDER-1001. Example Trail Shop. Synthetic delivery update.";
    const checksum = await sha256Hex(bodyText);
    const mail = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: `synthetic-review-${party.id}`,
      content: { bodyText, bodyHtml: null, snippet: null },
      vendorId: vendor.id,
      messageId: "older-order-mail",
      sender: "orders@example.test",
      subject: "Older order update",
      receivedAt: new Date("2026-09-10T15:00:00.000Z"),
      rawChecksum: checksum,
    });
    if (!mail) throw new Error("test setup: mail missing");
    await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "delivered",
        orderId: "TS-OLDER-1001",
        sourceKey: `classified:${checksum}:0`,
      });
    const worklist = await listVendorOrderMail(ctx.db, {
      vendorId: vendor.shortcode,
    });
    expect(worklist.items[0]?.events[0]?.candidates[0]).toMatchObject({
      purchaseId: older.shortcode,
      reason: "exact_order_id",
    });
  });

  it("carries a reviewed mail link to the surviving Purchase on merge", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Trail Shop",
    });
    const loser = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "TS-MERGE-1001",
      date: "2026-09-10",
    });
    const keeper = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-10",
    });
    const bodyText =
      "Order TS-MERGE-1001. Example Trail Shop. Synthetic original order update.";
    const checksum = await sha256Hex(bodyText);
    const mail = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: `synthetic-review-${party.id}`,
      content: { bodyText, bodyHtml: null, snippet: null },
      vendorId: vendor.id,
      messageId: "merged-order-mail",
      sender: "orders@example.test",
      subject: "Merged order update",
      receivedAt: new Date("2026-09-10T15:00:00.000Z"),
      rawChecksum: checksum,
    });
    if (!mail) throw new Error("test setup: mail missing");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "placed",
        orderId: "TS-MERGE-1001",
        sourceKey: `classified:${checksum}:0`,
      })
      .returning({ id: orderMailEvent.id });
    if (!event) throw new Error("test setup: event missing");
    await decideOrderMailCandidate(
      ctx.db,
      {
        eventId: event.id,
        purchaseId: loser.shortcode,
        decision: "linked",
        evidenceChecksum: checksum,
      },
      ctx.actor,
    );
    await mergePurchases(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      ctx.actor,
    );
    const timeline = await listPurchaseOrderMail(ctx.db, {
      purchaseId: keeper.shortcode,
    });
    expect(timeline.items[0]?.events[0]?.candidates[0]).toMatchObject({
      purchaseId: keeper.shortcode,
      decision: "linked",
    });
  });
});
