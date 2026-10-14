import type { EmailFilters } from "@cubby/schemas/email";
import {
  parseShortcodeFor,
  purchaseId,
  type EmailShortcode,
} from "@cubby/schemas/identifiers";
import { purchaseShortcode, SHORTCODE_CHARS } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, sql } from "drizzle-orm";
import { seedEmailLinkDecision } from "tooling/shared-assessment-fixtures";
/**
 * Email↔Purchase failure modes (ADR 0011: links are derived, never stored as
 * a second graph): accepted sources, reviewed links and live suggestions must
 * each place an Email on its Purchase, Vendor and account; a dismissal must
 * survive rereads and lose to a later Link; a member's Link must win a race
 * with an automatic link; an import-accepted source cannot be dismissed; a
 * Link that replaces another Purchase's link keeps who proposed that link;
 * only the Email's owner decides; and none of it changes spend.
 */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  importSourceClaim,
  importSourceOrder,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  assessmentEmailLink as orderMailCandidateDecision,
  assessmentState,
  orderMailEvent,
  purchase as purchaseTable,
  vendorAccount,
} from "~/server/db/schema";
import { decideEmailPurchase } from "~/server/purchase-import/email-purchase-decision";
import { syntheticRetainedMail } from "~/server/purchase-import/gmail/retained-mail.fixtures";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { listEmailsRead } from "~/server/repo/email";
import { buildEntityReport } from "~/server/repo/entity-report";
import { mergePurchases } from "~/server/repo/purchase";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

describe("Email Purchase links", () => {
  const ctx = withTestDb();

  const list = async (filters: EmailFilters) =>
    (
      await listEmailsRead(
        ctx.db,
        filters,
        [{ orderBy: "linkState", direction: "asc" }],
        { pageIndex: 0, pageSize: 50 },
      )
    ).data;

  async function emailCode(orderMailId: string) {
    const [row] = await getDb(ctx.db)
      .select({ shortcode: emailTable.shortcode })
      .from(emailTable)
      .where(eq(emailTable.orderMailId, orderMailId));
    if (!row) throw new Error("Synthetic Email missing");
    return parseShortcodeFor("email", row.shortcode);
  }

  const decide = async (
    id: EmailShortcode,
    purchase: { shortcode: string },
    checksum: string,
    decision: "linked" | "dismissed",
  ) =>
    decideEmailPurchase(
      ctx.db,
      {
        id,
        expectedChecksum: checksum,
        purchaseId: parseShortcodeFor("purchase", purchase.shortcode),
        decision,
      },
      ctx.actor,
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

  it.each(["accepted_alias", "accepted_attachment"] as const)(
    "places owned content-cleared %s evidence on its Vendor and Purchase",
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
      // Accepted bytes match the current original: the attachment's own
      // checksum, or the Email's for a message source.
      const checksum =
        sourceKind === "accepted_attachment"
          ? "f".repeat(64)
          : original.rawChecksum;
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
      await getDb(ctx.db).insert(importSourceOrder).values({
        sourceClaimId: acceptedClaim.id,
        orderKey: "synthetic-accepted-review-order",
        purchaseId: purchase.id,
        checksum,
        outputFingerprint: "synthetic-accepted-review-fingerprint",
      });
      // Another member's copy of the same message, accepted onto this
      // member's account Purchase, never relates.
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
      const expected = [
        expect.objectContaining({
          messageId: original.messageId,
          ledgerPartyId: party.shortcode,
          sender: null,
          subject: null,
          receivedAt: null,
          linkState: "linked",
          importOutcome: "imported",
          purchaseLinks: [
            {
              purchaseId: purchase.shortcode,
              state: "linked",
              accepted: true,
              changedSinceReview: false,
              replacesPurchaseIds: [],
              proposedBy: "import",
            },
          ],
        }),
      ];
      const code = parseShortcodeFor("vendor", vendor.shortcode);
      expect(await list({ vendorId: code })).toEqual(expected);
      expect(
        await list({
          purchaseId: parseShortcodeFor("purchase", purchase.shortcode),
        }),
      ).toEqual(expected);
      expect(
        await list({
          vendorAccountId: parseShortcodeFor(
            "vendorAccount",
            account.shortcode,
          ),
        }),
      ).toEqual(expected);
      expect(
        await list({
          vendorId: code,
          ledgerPartyId: [
            parseShortcodeFor("ledgerParty", foreignParty.shortcode),
          ],
        }),
      ).toEqual([]);
      expect(await reviewSourceState()).toEqual(before);
    },
  );

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
      threadId: "synthetic-retention-thread",
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
    return {
      party,
      source,
      event,
      purchase,
      vendor,
      checksum,
      runId: scope.id,
      email: await emailCode(source.id),
    };
  }

  it.each(["deleted", "excluded"] as const)(
    "keeps owned %s processing history and the import Run's state after content disposal",
    async (status) => {
      const f = await retainedReviewFixture();
      await getDb(ctx.db)
        .update(emailTable)
        .set({
          classification: "related",
          status,
          runId: f.runId,
          contentClearedAt: new Date("2026-10-02T13:00:00Z"),
        })
        .where(eq(emailTable.orderMailId, f.source.id));
      const [row] = await list({
        vendorId: parseShortcodeFor("vendor", f.vendor.shortcode),
      });
      expect(row).toMatchObject({
        messageId: f.source.messageId,
        status,
        importOutcome: "importing",
        linkState: "suggested",
      });
    },
  );

  // Processing, accepted sources and reviewed links are separate facts; none
  // establishes Product verification.
  it("shows processing separately from accepted sources and reviewed links", async () => {
    const f = await retainedReviewFixture();
    await getDb(ctx.db)
      .update(emailTable)
      .set({ classification: "uncertain", status: "blocked", runId: f.runId })
      .where(eq(emailTable.orderMailId, f.source.id));
    // The same message in another mailbox is a different Email.
    await syntheticRetainedMail(ctx.db, {
      ...f.source,
      id: undefined,
      mailboxId: "synthetic-other-mailbox",
      vendorId: null,
    });
    await seedEmailLinkDecision(ctx.db, {
      eventId: f.event.id,
      purchaseId: f.purchase.id,
      decision: "linked",
      evidenceChecksum: f.checksum,
      decidedByUserId: ctx.actor.userId,
      proposedBy: "agent",
    });
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: f.source.ledgerPartyId,
        kind: "mail_message",
        externalKey: `gmail:${f.source.mailboxId}:${f.source.messageId}`,
        checksum: f.checksum,
        firstRunId: f.runId,
        lastRunId: f.runId,
      })
      .returning();
    if (!claim) throw new Error("Synthetic accepted mail claim missing");
    await getDb(ctx.db).insert(importSourceOrder).values({
      sourceClaimId: claim.id,
      orderKey: "synthetic-accepted-order",
      purchaseId: f.purchase.id,
      checksum: f.checksum,
      outputFingerprint: "synthetic-accepted-mail",
    });
    expect(
      await list({
        purchaseId: parseShortcodeFor("purchase", f.purchase.shortcode),
      }),
    ).toEqual([
      expect.objectContaining({
        id: f.email,
        classification: "uncertain",
        status: "blocked",
        importOutcome: "imported",
        purchaseLinks: [
          expect.objectContaining({ state: "linked", accepted: true }),
        ],
      }),
    ]);
    const report = await buildEntityReport(
      ctx.db,
      { slot: "email.review", id: f.email },
      async () => null,
      ctx.actor,
    );
    const rows = report.blocks.flatMap((block) =>
      block.kind === "records" ? block.rows : [],
    );
    const linksBlock = report.blocks.find(
      (block) => block.kind === "records" && block.title === "Purchase links",
    );
    const linked =
      linksBlock?.kind === "records"
        ? linksBlock.rows.find((row) => row.id === f.purchase.shortcode)
        : undefined;
    expect(linked?.state).toEqual({ kind: "done", label: "Linked" });
    expect(linked?.badges).toEqual([
      { label: "Imported from this Email", tone: "muted" },
    ]);
    // An import-accepted source offers no Dismiss.
    expect(linked?.commands ?? []).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("Verified");
    expect(rows.find((row) => row.title === "Retrieved")?.externalLink).toEqual(
      {
        label: "Open in Gmail",
        url: "https://mail.google.com/mail/u/0/#all/synthetic-retention-thread",
        hint: expect.stringMatching(/^Mailbox /u),
      },
    );
  });

  // Accepted sources, not a nullable sender hint, make a multi-merchant
  // original readable on every supported Purchase.
  it("places accepted multi-Vendor mail with no sender proof on each related Vendor and Purchase", async () => {
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
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: f.source.ledgerPartyId,
        kind: "mail_message",
        externalKey: `gmail:${f.source.mailboxId}:${f.source.messageId}`,
        checksum: f.checksum,
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
          checksum: f.checksum,
          outputFingerprint: `synthetic-accepted-${p.id}`,
        })),
      );
    for (const [p, v] of [
      [f.purchase, f.vendor],
      [secondPurchase, secondVendor],
    ] as const) {
      expect(
        (
          await list({ vendorId: parseShortcodeFor("vendor", v.shortcode) })
        ).map((row) => row.messageId),
      ).toEqual([f.source.messageId]);
      expect(
        (
          await list({
            purchaseId: parseShortcodeFor("purchase", p.shortcode),
          })
        ).flatMap((row) => row.purchaseLinks),
      ).toEqual([
        expect.objectContaining({ purchaseId: p.shortcode, state: "linked" }),
      ]);
    }
    const report = await buildEntityReport(
      ctx.db,
      { slot: "email.review", id: f.email },
      async () => null,
      ctx.actor,
    );
    expect(JSON.stringify(report)).not.toContain("1970");
    const [unchanged] = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.id, f.source.id));
    expect(unchanged?.vendorId).toBeNull();
  });

  it("links a reviewed retained original by its exact order id without sender proof", async () => {
    const f = await retainedReviewFixture();
    await getDb(ctx.db)
      .update(orderMail)
      .set({ vendorId: null })
      .where(eq(orderMail.id, f.source.id));
    await decide(f.email, f.purchase, f.checksum, "linked");
    expect(
      await getDb(ctx.db)
        .select()
        .from(orderMailCandidateDecision)
        .where(eq(orderMailCandidateDecision.eventId, f.event.id)),
    ).toEqual([
      expect.objectContaining({
        purchaseId: f.purchase.id,
        decision: "linked",
        evidenceChecksum: f.checksum,
        proposedBy: "heuristic",
      }),
    ]);
    const [unchanged] = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.id, f.source.id));
    expect(unchanged?.vendorId).toBeNull();
  });

  it("suggests an exact order, honors a durable dismissal, and lets Link replace it", async () => {
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
    // Same total, another order number: never a suggestion.
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "TS-SYN-3003",
      date: "2026-09-08",
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
    await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "placed",
        orderId: "TS-SYN-1001",
        amount: 48,
        currency: "USD",
        sourceKey: `classified:${checksum}:0`,
      });
    const email = await emailCode(mail.id);
    const vendorScope = {
      vendorId: parseShortcodeFor("vendor", vendor.shortcode),
    };
    const links = async () =>
      (await list(vendorScope)).flatMap((row) => row.purchaseLinks);
    expect(await links()).toEqual([
      expect.objectContaining({
        purchaseId: purchase.shortcode,
        state: "suggested",
        proposedBy: "heuristic",
      }),
    ]);

    await decide(email, purchase, checksum, "dismissed");
    expect((await links())[0]?.state).toBe("dismissed");

    await decide(email, purchase, checksum, "linked");
    expect((await links())[0]?.state).toBe("linked");
    const [account] = await getDb(ctx.db)
      .select({ id: vendorAccount.id })
      .from(vendorAccount)
      .where(eq(vendorAccount.vendorId, vendor.id));
    const [linkedPurchase] = await getDb(ctx.db)
      .select({ vendorAccountId: purchaseTable.vendorAccountId })
      .from(purchaseTable)
      .where(eq(purchaseTable.id, purchase.id));
    expect(account).toBeDefined();
    expect(linkedPurchase?.vendorAccountId).toBeNull();
    // A member's Link is relevance evidence.
    const [reviewed] = await getDb(ctx.db)
      .select({
        classification: emailTable.classification,
        stage: emailTable.classificationStage,
      })
      .from(emailTable)
      .where(eq(emailTable.orderMailId, mail.id));
    expect(reviewed).toEqual({
      classification: "related",
      stage: "resolution",
    });
  });

  it("records the member's resolution when a model already said related", async () => {
    const f = await retainedReviewFixture();
    await getDb(ctx.db)
      .update(emailTable)
      .set({ classification: "related", classificationStage: "model" })
      .where(eq(emailTable.orderMailId, f.source.id));
    await decide(f.email, f.purchase, f.checksum, "linked");
    const [reviewed] = await getDb(ctx.db)
      .select({
        classification: emailTable.classification,
        stage: emailTable.classificationStage,
      })
      .from(emailTable)
      .where(eq(emailTable.orderMailId, f.source.id));
    expect(reviewed).toEqual({
      classification: "related",
      stage: "resolution",
    });
  });

  it("warns when an accepted original changed after its import", async () => {
    const f = await retainedReviewFixture();
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: f.source.ledgerPartyId,
        kind: "mail_message",
        externalKey: `gmail:${f.source.mailboxId}:${f.source.messageId}`,
        checksum: "b".repeat(64),
        firstRunId: f.runId,
        lastRunId: f.runId,
      })
      .returning();
    await getDb(ctx.db)
      .insert(importSourceOrder)
      .values({
        sourceClaimId: claim!.id,
        orderKey: "synthetic-earlier-original",
        purchaseId: f.purchase.id,
        checksum: "b".repeat(64),
        outputFingerprint: "synthetic-earlier-original",
      });
    expect(
      (
        await list({
          purchaseId: parseShortcodeFor("purchase", f.purchase.shortcode),
        })
      ).flatMap((row) => row.purchaseLinks),
    ).toEqual([
      expect.objectContaining({
        state: "linked",
        accepted: true,
        changedSinceReview: true,
      }),
    ]);
  });

  it("suggests a matching total only within 45 household days, never a nearby date alone", async () => {
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
      statedTotal: 12,
    });
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-08-02",
      statedTotal: 12,
    });
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-17",
      statedTotal: 99,
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
    expect(
      (await list({ vendorId: parseShortcodeFor("vendor", vendor.shortcode) }))
        .flatMap((row) => row.purchaseLinks)
        .map((link) => link.purchaseId),
    ).toEqual([edge.shortcode]);
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
        orderMailId: mail.id,
        event: "placed",
        orderId: "RACE-1",
        currency: "USD",
        sourceKey: `classified:${checksum}:0`,
      })
      .returning({ id: orderMailEvent.id });
    const email = await emailCode(mail.id);

    // An automatic link sits uncommitted while the member links elsewhere.
    let commitAutomatic = () => {};
    const held = new Promise<void>((resolve) => {
      commitAutomatic = resolve;
    });
    const automaticLink = withTransaction(ctx.db, async (tx) => {
      await seedEmailLinkDecision(databaseForTransaction(tx), {
        eventId: event!.id,
        purchaseId: automatic!.id,
        decision: "linked",
        evidenceChecksum: checksum,
        decidedByUserId: "cubby-system",
      });
      await held;
    });
    const memberLink = decide(email, chosen!, checksum, "linked");
    await new Promise((resolve) => setTimeout(resolve, 300));
    commitAutomatic();
    await automaticLink;
    await expect(memberLink).resolves.toMatchObject({ state: "linked" });

    const links = await getDb(ctx.db)
      .select({ purchaseId: orderMailCandidateDecision.purchaseId })
      .from(orderMailCandidateDecision)
      .where(eq(orderMailCandidateDecision.decision, "linked"));
    expect(links).toEqual([{ purchaseId: chosen!.id }]);
  });

  it("suggests an older exact order beyond the newest 500 Purchases", async () => {
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
    await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "delivered",
        orderId: "TS-OLDER-1001",
        sourceKey: `classified:${checksum}:0`,
      });
    expect(
      await list({
        purchaseId: parseShortcodeFor("purchase", older.shortcode),
      }),
    ).toEqual([
      expect.objectContaining({
        linkState: "suggested",
        purchaseLinks: [
          expect.objectContaining({
            purchaseId: older.shortcode,
            state: "suggested",
          }),
        ],
      }),
    ]);
  });

  it("carries a reviewed link to the surviving Purchase on merge", async () => {
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
    await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "placed",
        orderId: "TS-MERGE-1001",
        sourceKey: `classified:${checksum}:0`,
      });
    await decide(await emailCode(mail.id), loser, checksum, "linked");
    await mergePurchases(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      ctx.actor,
    );
    expect(
      (
        await list({
          purchaseId: parseShortcodeFor("purchase", keeper.shortcode),
        })
      ).flatMap((row) => row.purchaseLinks),
    ).toEqual([
      expect.objectContaining({
        purchaseId: keeper.shortcode,
        state: "linked",
        proposedBy: "heuristic",
      }),
    ]);
  });

  it("refuses to dismiss an import-accepted source", async () => {
    const f = await retainedReviewFixture();
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: f.source.ledgerPartyId,
        kind: "mail_message",
        externalKey: `gmail:${f.source.mailboxId}:${f.source.messageId}`,
        checksum: f.checksum,
        firstRunId: f.runId,
        lastRunId: f.runId,
      })
      .returning();
    await getDb(ctx.db).insert(importSourceOrder).values({
      sourceClaimId: claim!.id,
      orderKey: "synthetic-accepted-order",
      purchaseId: f.purchase.id,
      checksum: f.checksum,
      outputFingerprint: "synthetic-accepted-mail",
    });
    await expect(
      decide(f.email, f.purchase, f.checksum, "dismissed"),
    ).rejects.toThrow(/reconciliation/u);
  });

  it("replaces another Purchase's agent link on the same event and keeps its proposer", async () => {
    const f = await retainedReviewFixture();
    const other = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "SYNTHETIC-OTHER",
    });
    await seedEmailLinkDecision(ctx.db, {
      eventId: f.event.id,
      purchaseId: other.id,
      decision: "linked",
      evidenceChecksum: f.checksum,
      decidedByUserId: ctx.actor.userId,
      proposedBy: "agent",
    });
    expect(
      (
        await list({
          purchaseId: parseShortcodeFor("purchase", f.purchase.shortcode),
        })
      ).flatMap((row) => row.purchaseLinks),
    ).toEqual([
      expect.objectContaining({
        purchaseId: f.purchase.shortcode,
        state: "suggested",
        replacesPurchaseIds: [other.shortcode],
      }),
    ]);
    await decide(f.email, f.purchase, f.checksum, "linked");
    const states = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(
        and(
          eq(assessmentState.family, "email_link"),
          sql`${assessmentState.data}->>'eventId' = ${f.event.id}`,
        ),
      );
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "superseded",
          active: false,
          data: expect.objectContaining({
            purchaseId: other.id,
            proposedBy: "agent",
          }),
        }),
        expect.objectContaining({
          status: "resolved",
          active: true,
          data: expect.objectContaining({
            purchaseId: f.purchase.id,
            proposedBy: "heuristic",
          }),
        }),
      ]),
    );
  });

  it("lets only the Email's owner decide, and reads another member's Email as metadata", async () => {
    const f = await retainedReviewFixture();
    const owner = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic other member",
      kind: "member",
    });
    await getDb(ctx.db)
      .update(emailTable)
      .set({ ledgerPartyId: owner.id })
      .where(eq(emailTable.orderMailId, f.source.id));
    await getDb(ctx.db)
      .update(orderMail)
      .set({ ledgerPartyId: owner.id })
      .where(eq(orderMail.id, f.source.id));
    await expect(
      decide(f.email, f.purchase, f.checksum, "linked"),
    ).rejects.toThrow(/owner/u);
    const report = await buildEntityReport(
      ctx.db,
      { slot: "email.review", id: f.email },
      async () => null,
      ctx.actor,
    );
    const rows = report.blocks.flatMap((block) =>
      block.kind === "records" ? block.rows : [],
    );
    expect(rows).toEqual([
      expect.objectContaining({ id: f.purchase.shortcode }),
    ]);
    expect(rows[0]?.commands).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("Email pipeline");
  });

  it("orders an Emails section linked, then suggested, then dismissed", async () => {
    const f = await retainedReviewFixture();
    const seed = async (messageId: string, orderId: string) => {
      const mail = await syntheticRetainedMail(ctx.db, {
        ledgerPartyId: f.party.id,
        mailboxId: "synthetic-retention-mailbox",
        vendorId: f.vendor.id,
        messageId,
        sender: "receipts@retention.example.test",
        subject: messageId,
        receivedAt: new Date("2026-10-01T12:00:00Z"),
        rawChecksum: await sha256Hex(messageId),
        content: { bodyText: messageId, bodyHtml: null, snippet: null },
      });
      await getDb(ctx.db)
        .insert(orderMailEvent)
        .values({
          orderMailId: mail.id,
          event: "shipped",
          orderId,
          sourceKey: `synthetic-${messageId}`,
        });
      return {
        email: await emailCode(mail.id),
        checksum: await sha256Hex(messageId),
      };
    };
    const dismissed = await seed("synthetic-dismissed", "SYNTHETIC-RETAINED");
    const linked = await seed("synthetic-linked", "SYNTHETIC-RETAINED");
    await decide(dismissed.email, f.purchase, dismissed.checksum, "dismissed");
    await decide(linked.email, f.purchase, linked.checksum, "linked");
    expect(
      (
        await list({
          purchaseId: parseShortcodeFor("purchase", f.purchase.shortcode),
        })
      ).map((row) => [row.id, row.linkState]),
    ).toEqual([
      [linked.email, "linked"],
      [f.email, "suggested"],
      [dismissed.email, "dismissed"],
    ]);
    expect(
      (
        await list({
          purchaseId: parseShortcodeFor("purchase", f.purchase.shortcode),
          linkState: ["dismissed"],
        })
      ).map((row) => row.id),
    ).toEqual([dismissed.email]);
    const [stored] = await getDb(ctx.db)
      .select({ id: orderMailCandidateDecision.id })
      .from(orderMailCandidateDecision)
      .where(
        and(
          eq(orderMailCandidateDecision.purchaseId, f.purchase.id),
          eq(orderMailCandidateDecision.decision, "dismissed"),
        ),
      );
    expect(stored).toBeDefined();
  });
});
