import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import {
  seedEmailClassificationFeedback,
  seedEmailLinkDecision,
} from "tooling/shared-assessment-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  emailClassificationObservation,
  importSourceClaim,
  importSourceOrder,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { executeEntity } from "~/server/entity-kernel";
import { buildKernelContext } from "~/server/entity-kernel/reference-universe.fixtures";
import { getConnectedRecords } from "~/server/generic/entity-links/repo/connected-records";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

// Persisted-read failures: contentless messages disappear; absent historical
// headers become invented values; owner filters leak; dismissal/thread context
// count as links; accepted aliases/attachments disappear after content clearing.
describe("Email generic persisted reads", () => {
  const ctx = withTestDb();

  async function owner(name: string) {
    return insertWithShortcode(ctx.db, "ledgerParty", {
      name,
      kind: "member",
    });
  }

  async function retain(
    party: Awaited<ReturnType<typeof owner>>,
    messageId: string,
  ) {
    const [content] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        rawChecksum: `checksum:${messageId}`,
      })
      .returning();
    if (!content) throw new Error("Synthetic original did not persist");
    return content;
  }

  // Lists read text presence without decompressing originals, so the derived
  // flag must be exact for null, blank and HTML-only content and follow writes.
  it("derives retained-text presence from the stored original on every write", async () => {
    const party = await owner("Synthetic presence owner");
    const cases = [
      {
        content: { snippet: null, bodyText: null, bodyHtml: null },
        present: false,
      },
      {
        content: { snippet: "  ", bodyText: " ", bodyHtml: "   " },
        present: false,
      },
      {
        content: {
          snippet: "Synthetic summary",
          bodyText: null,
          bodyHtml: null,
        },
        present: true,
      },
      {
        content: { snippet: null, bodyText: "Synthetic body", bodyHtml: null },
        present: true,
      },
      {
        content: {
          snippet: null,
          bodyText: null,
          bodyHtml: "<p>Synthetic original</p>",
        },
        present: true,
      },
      // PostgreSQL BTRIM removes spaces, not all JavaScript whitespace.
      {
        content: { snippet: "\t", bodyText: null, bodyHtml: null },
        present: true,
      },
      {
        content: { headers: { subject: "Synthetic header only" } },
        present: false,
      },
    ];
    const stored = [];
    for (const [index, sample] of cases.entries()) {
      const [row] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          rawChecksum: `checksum:presence-${index}`,
          content: sql`${JSON.stringify(sample.content)}::jsonb`,
        })
        .returning({ id: orderMail.id, present: orderMail.hasRetainedText });
      stored.push(row);
    }
    expect(stored.map((row) => row?.present)).toEqual(
      cases.map(({ present }) => present),
    );
    const [cleared] = await getDb(ctx.db)
      .update(orderMail)
      .set({ content: { snippet: null, bodyText: null, bodyHtml: null } })
      .where(eq(orderMail.id, stored[2]!.id))
      .returning({ present: orderMail.hasRetainedText });
    expect(cleared).toEqual({ present: false });
  });

  it("reads unrelated metadata without a body and filters owned Emails by headers and EML code", async () => {
    const party = await owner("Email reader");
    const otherParty = await owner("Other Email reader");
    const metadata = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageId: "newsletter",
      checksum: "synthetic-newsletter-checksum",
      sender: "news@example.test",
      subject: "Workshop newsletter",
      receivedAt: new Date("2026-09-03T18:00:00Z"),
      classification: "unrelated",
      classificationVersion: "synthetic-v1",
      classificationStage: "rule",
      classificationReason: "Newsletter without purchase evidence",
      status: "excluded",
    });
    const historical = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageId: "unavailable-original",
      checksum: "synthetic-unavailable-checksum",
      classification: "unrelated",
      classificationVersion: "synthetic-historical",
      status: "excluded",
    });
    await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: otherParty.id,
      mailboxId: "synthetic-mailbox",
      messageId: "other-owner-newsletter",
      checksum: "synthetic-other-owner-checksum",
      sender: "news@example.test",
      subject: "Workshop newsletter",
      classification: "unrelated",
      classificationVersion: "synthetic-v1",
      status: "excluded",
    });
    const context = buildKernelContext(ctx.db);
    const list = await executeEntity(context, {
      action: "list",
      entity: "email",
      filters: {
        ledgerPartyId: party.shortcode,
        sender: "news@example.test",
        subject: "Workshop",
        receivedAtFrom: "2026-09-03",
        receivedAtTo: "2026-09-03",
        classification: "unrelated",
        classificationStage: "rule",
        classificationReason: "Newsletter",
        status: "excluded",
        mailboxId: "synthetic-mailbox",
        linked: false,
      },
    });
    expect(list.items).toMatchObject([
      {
        id: metadata.shortcode,
        sender: "news@example.test",
        subject: "Workshop newsletter",
        receivedAt: new Date("2026-09-03T18:00:00Z"),
        ledgerPartyId: party.shortcode,
        classification: "unrelated",
        classificationStage: "rule",
        fields: {
          linked: {
            result: { decision: { outcome: { kind: "value", value: false } } },
          },
        },
      },
    ]);
    expect(list.meta.totalCount).toBe(1);
    const detail = await executeEntity(context, {
      action: "get",
      missing: "error",
      entity: "email",
      id: parseShortcodeFor("email", metadata.shortcode),
    });
    expect(detail.item).toMatchObject({
      id: metadata.shortcode,
      subject: "Workshop newsletter",
      fields: {
        linked: {
          result: { decision: { outcome: { kind: "value", value: false } } },
        },
      },
    });
    const unknown = await executeEntity(context, {
      action: "get",
      missing: "error",
      entity: "email",
      id: parseShortcodeFor("email", historical.shortcode),
    });
    expect(unknown.item).toMatchObject({
      sender: null,
      subject: null,
      receivedAt: null,
      classificationStage: null,
      classificationReason: null,
    });
    const selected = await executeEntity(context, {
      action: "list",
      entity: "email",
      filters: { ids: [metadata.shortcode] },
    });
    expect(selected.items.map((row) => row.id)).toEqual([metadata.shortcode]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
  });

  it("uses accepted source families and active lifecycle links while dismissals and thread context stay unlinked", async () => {
    const party = await owner("Association reader");
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic workshop vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "EXAMPLE-EML",
      date: "2026-09-03",
    });
    const admitted = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    const emails = new Map<string, Awaited<ReturnType<typeof retain>>>();
    const codes = new Map<string, string>();
    for (const messageId of [
      "accepted",
      "attachment",
      "lifecycle",
      "dismissed",
      "superseded",
      "thread-only",
    ]) {
      const content = await retain(party, messageId);
      emails.set(messageId, content);
      const row = await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-mailbox",
        messageId,
        orderMailId: content.id,
        checksum: content.rawChecksum,
        sender: "receipts@example.test",
        subject: "Workshop receipt",
        threadId: "shared-synthetic-thread",
        classification: "related",
        classificationVersion: "synthetic-v1",
        status: "completed",
      });
      codes.set(messageId, row.shortcode);
    }
    const firstRunId = admitted;
    for (const messageId of ["accepted", "attachment"]) {
      const content = emails.get(messageId)!;
      let externalKey = `gmail:${"synthetic-mailbox"}:${messageId}`;
      const kind =
        messageId === "attachment" ? "mail_attachment" : "mail_message";
      if (messageId === "attachment") {
        await getDb(ctx.db).insert(orderMailAttachment).values({
          orderMailId: content.id,
          providerAttachmentId: "receipt-image",
          filename: "receipt.png",
          mimeType: "image/png",
          checksum: "synthetic-attachment-checksum",
        });
        externalKey += ":attachment:receipt-image";
      }
      const [root] = await getDb(ctx.db)
        .insert(importSourceClaim)
        .values({
          ledgerPartyId: party.id,
          kind,
          externalKey,
          checksum: content.rawChecksum,
          firstRunId,
          lastRunId: firstRunId,
        })
        .returning();
      if (!root) throw new Error("Synthetic claim did not persist");
      const [alias] = await getDb(ctx.db)
        .insert(importSourceClaim)
        .values({
          ledgerPartyId: party.id,
          kind,
          externalKey: `${externalKey}:historical-alias`,
          canonicalClaimId: root.id,
          checksum: "synthetic-historical-source-checksum",
          firstRunId,
          lastRunId: firstRunId,
        })
        .returning();
      if (!alias) throw new Error("Synthetic alias did not persist");
      await getDb(ctx.db).insert(importSourceOrder).values({
        sourceClaimId: alias.id,
        orderKey: "synthetic-order",
        purchaseId: purchase.id,
        checksum: alias.checksum,
        outputFingerprint: "synthetic-output",
      });
    }
    for (const messageId of ["lifecycle", "dismissed", "superseded"]) {
      const content = emails.get(messageId)!;
      const [event] = await getDb(ctx.db)
        .insert(orderMailEvent)
        .values({
          orderMailId: content.id,
          event: "shipment",
          sourceKey: `synthetic:${messageId}`,
        })
        .returning();
      if (!event) throw new Error("Synthetic event did not persist");
      await seedEmailLinkDecision(ctx.db, {
        eventId: event.id,
        purchaseId: purchase.id,
        decision: messageId === "dismissed" ? "dismissed" : "linked",
        evidenceChecksum: content.rawChecksum,
        decidedByUserId: ctx.actor.userId,
      });
      if (messageId === "superseded")
        await getDb(ctx.db)
          .update(orderMailEvent)
          .set({ supersededAt: new Date("2026-09-04T18:00:00Z") })
          .where(eq(orderMailEvent.id, event.id));
    }
    // Retention removes bodies, not accepted source identity or association.
    await getDb(ctx.db).execute(
      sql`UPDATE "OrderMail" SET "content" = '{"snippet":null,"bodyText":null,"bodyHtml":null}'::jsonb`,
    );
    const context = buildKernelContext(ctx.db);
    const linked = await executeEntity(context, {
      action: "list",
      entity: "email",
      filters: { ledgerPartyId: party.shortcode, linked: true },
      pagination: { pageIndex: 0, pageSize: 1 },
    });
    // Derived Sources must reuse accepted/reviewed associations, never thread or dismissed candidates.
    const evidence = await getConnectedRecords(ctx.db, {
      source: { entityKind: "purchase", entityId: purchase.shortcode },
      viewKey: "source-emails",
    });
    expect(new Set(evidence.items.map((item) => item.target.entityId))).toEqual(
      new Set(
        ["accepted", "attachment", "lifecycle"].map((key) => codes.get(key)),
      ),
    );
    expect(evidence.items.map((item) => item.target.label)).toEqual([
      "Workshop receipt",
      "Workshop receipt",
      "Workshop receipt",
    ]);
    expect(
      evidence.items.every(
        (item) => item.paths[0]?.[0]?.entityId === purchase.shortcode,
      ),
    ).toBe(true);
    expect(linked.meta.totalCount).toBe(3);
    expect(linked.items[0]).toMatchObject({
      fields: {
        linked: {
          result: { decision: { outcome: { kind: "value", value: true } } },
        },
      },
    });
    const unlinked = await executeEntity(context, {
      action: "list",
      entity: "email",
      filters: { ledgerPartyId: party.shortcode, linked: false },
    });
    expect(new Set(unlinked.items.map((row) => row.id))).toEqual(
      new Set(
        ["dismissed", "superseded", "thread-only"].map((key) => codes.get(key)),
      ),
    );
    for (const messageId of [
      "accepted",
      "attachment",
      "lifecycle",
      "dismissed",
      "thread-only",
    ]) {
      const detail = await executeEntity(context, {
        action: "get",
        missing: "error",
        entity: "email",
        id: codes.get(messageId)!,
      });
      expect(detail.item).toMatchObject({
        fields: {
          linked: {
            result: {
              decision: {
                outcome: {
                  kind: "value",
                  value: ["accepted", "attachment", "lifecycle"].includes(
                    messageId,
                  ),
                },
              },
            },
          },
        },
      });
    }
  });
  it("shows independent reviewed relevance without rewriting routing and marks changed content unreviewed", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic independent reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const email = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-review",
      messageId: "graded",
      checksum: "a".repeat(64),
      classification: "unrelated",
      status: "completed",
    });
    const [prediction] = await getDb(ctx.db)
      .insert(emailClassificationObservation)
      .values({
        emailId: email.id,
        checksum: email.checksum,
        classification: "unrelated",
        stage: "decision",
        reason: "Synthetic initial prediction",
        classificationVersion: "synthetic-v1",
      })
      .returning();
    if (!prediction) throw new Error("Synthetic prediction missing");
    await seedEmailClassificationFeedback(ctx.db, {
      predictionId: prediction.id,
      classification: "related",
      reason: "Synthetic independent message review",
      actorUserId: ctx.actor.userId,
    });
    const context = buildKernelContext(ctx.db);
    const detail = await executeEntity(context, {
      action: "get",
      missing: "error",
      entity: "email",
      id: parseShortcodeFor("email", email.shortcode),
    });
    expect(detail.item).toMatchObject({
      classification: "unrelated",
      fields: {
        reviewedClassification: {
          result: {
            decision: { outcome: { kind: "value", value: "related" } },
          },
        },
        reviewedClassificationReason: {
          result: {
            decision: {
              outcome: {
                kind: "value",
                value: "Synthetic independent message review",
              },
            },
          },
        },
      },
    });
    await getDb(ctx.db).execute(
      sql`UPDATE "Email" SET checksum = ${"b".repeat(64)} WHERE id = ${email.id}::uuid`,
    );
    const changed = await executeEntity(context, {
      action: "get",
      missing: "error",
      entity: "email",
      id: parseShortcodeFor("email", email.shortcode),
    });
    expect(changed.item).toMatchObject({
      classification: "unrelated",
      fields: {
        reviewedClassification: {
          result: { decision: { outcome: { kind: "empty" } } },
        },
        reviewedClassificationReason: {
          result: { decision: { outcome: { kind: "empty" } } },
        },
      },
    });
  });
});
