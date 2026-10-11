import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  emailClassificationObservation,
  emailClassificationLabel,
  email as emailTable,
  importSourceClaim,
  importSourceOrder,
  orderMail,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
} from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import { buildKernelContext } from "~/server/entity-kernel/reference-universe.fixtures";
import { getDb } from "~/server/repo/database-helpers";
import {
  createEmailAccuracyEvaluation,
  gradeEmailAccuracyItem,
  listBlindEmailAccuracyItems,
} from "~/server/repo/email-accuracy";
import {
  emailAccuracyViewReport,
  emailReviewReport,
} from "~/server/repo/entity-report/email";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

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
    expect(list.items).toEqual([
      expect.objectContaining({
        id: metadata.shortcode,
        sender: "news@example.test",
        subject: "Workshop newsletter",
        receivedAt: new Date("2026-09-03T18:00:00Z"),
        ledgerPartyId: party.shortcode,
        classification: "unrelated",
        classificationStage: "rule",
        linked: false,
      }),
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
      linked: false,
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
          supersededAt:
            messageId === "superseded"
              ? new Date("2026-09-04T18:00:00Z")
              : null,
        })
        .returning();
      if (!event) throw new Error("Synthetic event did not persist");
      await getDb(ctx.db)
        .insert(orderMailCandidateDecision)
        .values({
          eventId: event.id,
          purchaseId: purchase.id,
          decision: messageId === "dismissed" ? "dismissed" : "linked",
          evidenceChecksum: content.rawChecksum,
          decidedByUserId: ctx.actor.userId,
        });
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
    expect(linked.meta.totalCount).toBe(3);
    expect(linked.items[0]).toMatchObject({ linked: true });
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
        linked: ["accepted", "attachment", "lifecycle"].includes(messageId),
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
        stage: "jev",
        reason: "Synthetic initial prediction",
        classificationVersion: "synthetic-v1",
      })
      .returning();
    if (!prediction) throw new Error("Synthetic prediction missing");
    await getDb(ctx.db).insert(emailClassificationLabel).values({
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
      reviewedClassification: "related",
      reviewedClassificationReason: "Synthetic independent message review",
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
      reviewedClassification: null,
      reviewedClassificationReason: null,
    });
  });

  // Unequal strata must retain their denominators in the built-in report;
  // reviewed relevance remains evidence-bound and never changes import routing.
  it("renders the latest owned accuracy evaluation with weighted numbers and evidence-bound independent labels", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic report reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    for (const group of [
      {
        name: "Synthetic false positives",
        count: 6,
        classification: "related",
        stage: "jev",
        model: "typesafe/jev",
      },
      {
        name: "Synthetic true positives",
        count: 2,
        classification: "related",
        stage: "rule",
        model: null,
      },
      {
        name: "Synthetic false negatives",
        count: 4,
        classification: "unrelated",
        stage: "model",
        model: "@cf/cloudflare/clef",
      },
    ] satisfies Array<{
      name: string;
      count: number;
      classification: "related" | "unrelated";
      stage: "jev" | "rule" | "model";
      model: string | null;
    }>) {
      for (let index = 0; index < group.count; index++) {
        const email = await insertWithShortcode(ctx.db, "email", {
          ledgerPartyId: party.id,
          mailboxId: "synthetic-report-mailbox",
          messageId: `${group.name}:${index}`,
          subject: group.name,
          sender: "synthetic@example.test",
          checksum: "a".repeat(64),
          classification: group.classification,
          status: "excluded",
        });
        await getDb(ctx.db).insert(emailClassificationObservation).values({
          emailId: email.id,
          checksum: email.checksum,
          classification: group.classification,
          stage: group.stage,
          model: group.model,
          reason: "Synthetic classifier evidence",
          classificationVersion: "synthetic-v1",
        });
      }
    }
    await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-report-mailbox",
      messageId: "unknown-report-prediction",
      checksum: "z".repeat(64),
      classification: null,
      status: "pending",
    });
    await createEmailAccuracyEvaluation(ctx.db, { sampleSize: 12 }, ctx.actor);
    const evaluation = await createEmailAccuracyEvaluation(
      ctx.db,
      { sampleSize: 3 },
      ctx.actor,
    );
    const blind = await listBlindEmailAccuracyItems(
      ctx.db,
      { evaluationId: evaluation.evaluationId },
      ctx.actor,
    );
    for (const item of blind.items) {
      await gradeEmailAccuracyItem(
        ctx.db,
        {
          evaluationId: evaluation.evaluationId,
          predictionId: item.predictionId,
          grade:
            item.headers?.subject === "Synthetic false positives"
              ? "unrelated"
              : "related",
          reviewedChecksum: "a".repeat(64),
          reason: "Synthetic original message reviewed independently",
        },
        ctx.actor,
      );
    }
    const selected = blind.items.find(
      (item) => item.headers?.subject === "Synthetic false positives",
    );
    if (!selected?.emailId) throw new Error("Synthetic selected Email missing");
    // Member-wide accuracy lives in the list's Accuracy view, not each Email.
    const { blocks } = await emailAccuracyViewReport(ctx.db, ctx.actor);
    const detail = await emailReviewReport(
      ctx.db,
      selected.emailId,
      null,
      ctx.actor,
    );
    expect(
      detail.flatMap((block) =>
        block.kind === "stats" ? block.figures.map((figure) => figure.id) : [],
      ),
    ).not.toContainEqual(expect.stringMatching(/^email-accuracy-/u));
    const figures = new Map(
      blocks
        .flatMap((block) => (block.kind === "stats" ? block.figures : []))
        .map((figure) => [figure.id, figure.value]),
    );
    expect(
      Object.fromEntries(
        [...figures].filter(([id]) => id?.startsWith("email-accuracy-")),
      ),
    ).toMatchObject({
      "email-accuracy-member-emails": 13,
      "email-accuracy-unpredicted-emails": 1,
      "email-accuracy-population": 12,
      "email-accuracy-sample": 3,
      "email-accuracy-graded": 3,
      "email-accuracy-ungraded": 0,
      "email-accuracy-unknown-model": 1,
      "email-accuracy-pipeline-binary-pairs": 3,
      "email-accuracy-pipeline-weighted-population": 12,
      "email-accuracy-pipeline-tp": 2,
      "email-accuracy-pipeline-fp": 6,
      "email-accuracy-pipeline-fn": 4,
      "email-accuracy-pipeline-tn": 0,
      "email-accuracy-pipeline-precision": 0.25,
      "email-accuracy-pipeline-recall": 1 / 3,
      "email-accuracy-model-only-binary-pairs": 2,
      "email-accuracy-model-only-weighted-population": 10,
      "email-accuracy-model-only-tp": 0,
      "email-accuracy-model-only-fp": 6,
      "email-accuracy-model-only-fn": 4,
      "email-accuracy-model-only-tn": 0,
      "email-accuracy-model-only-precision": 0,
      "email-accuracy-model-only-recall": 0,
    });
    const strata = blocks.find(
      (block) => block.kind === "table" && block.title === "Accuracy strata",
    );
    if (strata?.kind !== "table")
      throw new Error("Accuracy denominators missing");
    const values = strata.rows.map((row) =>
      ["Population N", "Sample n", "Inclusion probability", "Weight"].map(
        (column) => Number(row.cells[strata.columns.indexOf(column)]),
      ),
    );
    expect(values.sort((a, b) => a[0]! - b[0]!)).toEqual([
      [2, 1, 0.5, 2],
      [4, 1, 0.25, 4],
      [6, 1, 1 / 6, 6],
    ]);
    expect(
      blocks
        .flatMap((block) =>
          block.kind === "records" ? (block.commands ?? []) : [],
        )
        .map((command) => command.request),
    ).toContainEqual({ kind: "create-email-accuracy", sampleSize: 200 });
    const reviews = detail.find(
      (block) => block.kind === "table" && block.title === "Member reviews",
    );
    if (reviews?.kind !== "table")
      throw new Error("Independent reviews missing");
    expect(reviews.rows[0]?.cells).toContain("unrelated");
    expect(reviews.rows[0]?.cells).toContain("Current");
    const [before] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.shortcode, selected.emailId));
    if (!before) throw new Error("Synthetic Email missing");
    expect(before.classification).toBe("related");
    await getDb(ctx.db)
      .update(emailTable)
      .set({ checksum: "b".repeat(64) })
      .where(eq(emailTable.id, before.id));
    const [updated] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.id, before.id));
    const changed = await emailReviewReport(
      ctx.db,
      selected.emailId,
      null,
      ctx.actor,
    );
    const stale = changed.find(
      (block) => block.kind === "table" && block.title === "Member reviews",
    );
    if (stale?.kind !== "table")
      throw new Error("Stale review history missing");
    expect(stale.rows[0]?.cells).toContain("Stale");
    const [after] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.id, before.id));
    expect(after).toEqual(updated);
    expect(after).toMatchObject({
      classification: "related",
      checksum: "b".repeat(64),
    });
    expect(
      await getDb(ctx.db).select().from(emailClassificationLabel),
    ).toHaveLength(3);
  });
});
