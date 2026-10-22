/** Predictions remain immutable after member labels; accepted content survives
 * contradictory predictions, and retrieval failures never invent classifications. */
import { eq } from "drizzle-orm";
import {
  listFeedbackByKind,
  seedEmailClassificationFeedback,
} from "tooling/shared-assessment-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  emailClassificationObservation,
  emailRetrievalFailure,
  email as emailTable,
  importSourceClaim,
} from "~/server/db/schema";
import { orderMailEvent } from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { publishEmailLinkDecision } from "~/server/generic/assessment/repo/assessment-email-link";
import { listAutomaticDecisions } from "~/server/generic/assessment/repo/automatic-decisions";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { runFinding } from "~/server/testing/run-finding.fixtures";

import { ingestGmailMessages } from "../../service/gmail/ingest";
import { importedPurchaseFixture } from "../../service/import-run.fixtures";
import { GmailApiError, type GmailProvider } from "./types";
const storage = {
  put: async () => undefined,
  get: async () => new Uint8Array(),
  delete: async () => undefined,
};
const gmail: GmailProvider = {
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({}),
  listHistory: async () => ({}),
  getAttachment: async () => ({}),
  getMessage: async (id) => ({
    id,
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: "Synthetic evidence" }],
      body: { data: Buffer.from("Synthetic body").toString("base64url") },
    },
  }),
};
describe("immutable Email observations", () => {
  const ctx = withTestDb();
  // Event-only authority can predate a retained Email. Audit expansion must
  // recover the Email through the original, alongside the current Purchase.
  it("finds an automatic event-only link from either later-retained endpoint", async () => {
    const fixture = await importedPurchaseFixture(ctx.db, ctx.actor);
    await ingestGmailMessages(ctx.db, gmail, {
      ledgerPartyId: fixture.party.id,
      mailboxId: "synthetic-link-mailbox",
      messageIds: ["synthetic-link-message"],
      storage,
      callerJudges: true,
    });
    const [mail] = await getDb(ctx.db).select().from(emailTable);
    if (!mail?.orderMailId) throw new Error("Synthetic retained Email missing");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.orderMailId,
        event: "placed",
        orderId: "SYNTHETIC-LINK",
        amount: 5,
        currency: "USD",
        sourceKey: `synthetic:${mail.orderMailId}`,
      })
      .returning();
    if (!event) throw new Error("Synthetic retained event missing");
    await getDb(ctx.db)
      .update(emailTable)
      .set({ deletedAt: new Date() })
      .where(eq(emailTable.id, mail.id));
    const prediction = await publishEmailLinkDecision(
      ctx.db,
      {
        eventId: event.id,
        purchaseId: fixture.order.id,
        decision: "linked",
        evidenceChecksum: mail.checksum!,
        decidedByUserId: ctx.actor.userId,
        proposedBy: "heuristic",
      },
      "automatic",
    );
    expect(prediction.subject).toMatchObject({ recordId: null });
    await getDb(ctx.db)
      .update(emailTable)
      .set({ deletedAt: null })
      .where(eq(emailTable.id, mail.id));
    const outcome = await publishAssessment(ctx.db, {
      publicationKey: `synthetic-mail-outcome:${mail.id}`,
      family: "mail_import_outcome",
      subject: {
        kind: "mail_import_outcome",
        entity: "email",
        recordId: mail.id,
        checksum: mail.checksum!,
        runId: fixture.parent.id,
      },
      judgment: {
        kind: "imported",
        lines: [{ name: "Synthetic packet", cost: 5 }],
        total: 5,
      },
      producer: null,
      fingerprint: mail.checksum,
      evidence: null,
    });
    for (const code of [mail.shortcode, fixture.order.shortcode]) {
      const audit = await listAutomaticDecisions(ctx.db, {
        family: "email_link",
        recordIds: [code],
      });
      expect(
        audit.items.find((row) => row.id === prediction.id)?.records,
      ).toEqual(
        expect.arrayContaining([
          { entity: "email", id: mail.shortcode },
          { entity: "purchase", id: fixture.order.shortcode },
        ]),
      );
      const outcomes = await listAutomaticDecisions(ctx.db, {
        family: "mail_import_outcome",
        recordIds: [code],
      });
      expect(
        outcomes.items.find((row) => row.id === outcome.id)?.records,
      ).toEqual(
        expect.arrayContaining([
          { entity: "email", id: mail.shortcode },
          { entity: "purchase", id: fixture.order.shortcode },
        ]),
      );
    }
  });
  it("persists prediction before a label and keeps raw retrieval failures separate", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageIds: ["synthetic-message"],
      storage,
      triage: async () => "uncertain" as const,
    };
    await ingestGmailMessages(ctx.db, gmail, input);
    const [email] = await getDb(ctx.db).select().from(emailTable);
    const predictions = await getDb(ctx.db)
      .select()
      .from(emailClassificationObservation);
    expect(predictions).toHaveLength(1);
    const prediction = predictions[0];
    if (!email || !prediction) throw new Error("Synthetic prediction missing");
    // A saved prediction alone cannot establish that routing used it. Ingest
    // must record application in the same publication transaction.
    expect(
      await listFeedbackByKind(ctx.db, "email_classification_application"),
    ).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          predictionId: prediction.id,
          applied: true,
        }),
      }),
    ]);
    expect(
      (
        await listAutomaticDecisions(ctx.db, {
          family: "email_relevance",
          recordIds: [email.shortcode],
        })
      ).items,
    ).toEqual([
      expect.objectContaining({
        applicationVerified: true,
        decision: { classification: "uncertain", stage: "decision" },
      }),
    ]);
    expect(prediction).toMatchObject({
      emailId: email.id,
      classification: "uncertain",
      stage: "decision",
      checksum: email.checksum,
      runId: null,
      model: null,
      usageId: null,
      conflict: null,
    });
    await seedEmailClassificationFeedback(ctx.db, {
      predictionId: prediction.id,
      classification: "related",
      reason: "Synthetic member correction",
      actorUserId: ctx.actor.userId,
    });
    await ingestGmailMessages(ctx.db, gmail, input);
    expect(
      await getDb(ctx.db).select().from(emailClassificationObservation),
    ).toEqual(predictions);
    expect(
      await listFeedbackByKind(ctx.db, "email_classification_review"),
    ).toHaveLength(1);
    const raw = "404 Not Found: Synthetic upstream response";
    await ingestGmailMessages(
      ctx.db,
      {
        ...gmail,
        getMessage: async () => {
          throw new GmailApiError({ message: raw, status: 404 });
        },
      },
      input,
    );
    expect(
      await getDb(ctx.db).select().from(emailClassificationObservation),
    ).toEqual(predictions);
    expect(
      await getDb(ctx.db).select().from(emailRetrievalFailure),
    ).toMatchObject([
      { emailId: email.id, httpStatus: 404, error: raw, runId: null },
    ]);
  });
  it.each([false, true])(
    "records an accepted-unrelated conflict and preserves accepted bytes (Run: %s)",
    async (withRun) => {
      const fixture = await importedPurchaseFixture(ctx.db, ctx.actor);
      if (!fixture.association)
        throw new Error("Synthetic association missing");
      const input = {
        ledgerPartyId: fixture.party.id,
        mailboxId: "synthetic-mailbox",
        messageIds: ["accepted-message"],
        storage,
      };
      await ingestGmailMessages(ctx.db, gmail, {
        ...input,
        callerJudges: true,
      });
      const [original] = await readRetainedMail(ctx.db, {
        ledgerPartyIds: [fixture.party.id],
      });
      if (!original) throw new Error("Synthetic original missing");
      await getDb(ctx.db)
        .update(importSourceClaim)
        .set({
          externalKey: `gmail:${original.mailboxId}:${original.messageId}`,
          checksum: original.rawChecksum,
        })
        .where(eq(importSourceClaim.id, fixture.association.sourceClaimId));
      await getDb(ctx.db)
        .update(emailTable)
        .set({ classificationVersion: "synthetic-prior-version" })
        .where(eq(emailTable.messageId, "accepted-message"));
      const runId = withRun
        ? await ensureRun(ctx.db, ctx.actor, {
            purpose: "mail_discovery",
            trigger: "manual",
            status: "running",
            input: {
              mailboxId: input.mailboxId,
              scopedQueries: [],
              executionPolicy: "classification_only",
            },
          })
        : undefined;
      await ingestGmailMessages(ctx.db, gmail, {
        ...input,
        runId,
        triage: async () => "unrelated",
      });
      const [prediction] = await getDb(ctx.db)
        .select()
        .from(emailClassificationObservation)
        .where(eq(emailClassificationObservation.classification, "unrelated"));
      expect(prediction).toMatchObject({
        classification: "unrelated",
        conflict: { kind: "accepted_unrelated" },
      });
      const audit = await listAutomaticDecisions(ctx.db, {
        family: "email_relevance",
      });
      expect(
        audit.items.some(
          (row) =>
            row.decision &&
            typeof row.decision === "object" &&
            "classification" in row.decision &&
            row.decision.classification === "unrelated",
        ),
      ).toBe(false);
      const findings = await getDb(ctx.db).select().from(runFinding);
      expect(findings).toMatchObject(
        withRun
          ? [
              {
                runId,
                entityKind: "email",
                entityId: prediction?.emailId,
                kind: "other",
                status: "open",
              },
            ]
          : [],
      );
      expect(findings).toHaveLength(withRun ? 1 : 0);
      expect(
        await readRetainedMail(ctx.db, { ledgerPartyIds: [fixture.party.id] }),
      ).toEqual([original]);
      expect((await getDb(ctx.db).select().from(emailTable))[0]).toMatchObject({
        orderMailId: original.id,
        contentClearedAt: null,
      });
    },
  );
});
