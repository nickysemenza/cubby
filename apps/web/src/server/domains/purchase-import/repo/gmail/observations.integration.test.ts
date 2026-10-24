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
import { ensureEmailAssessment } from "~/server/generic/assessment/repo/assessment-email";
import { publishEmailLinkDecision } from "~/server/generic/assessment/repo/assessment-email-link";
import { listAutomaticDecisions } from "~/server/generic/assessment/repo/automatic-decisions";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { runFinding } from "~/server/testing/run-finding.fixtures";

import { ingestGmailMessages } from "../../service/gmail/ingest";
import { importedPurchaseFixture } from "../../service/import-run.fixtures";
import { recordEmailClassificationObservation } from "./observations";
import { captureGmailOriginal } from "./original-capture";
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
      searchActor: ctx.actor,
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
    const legacy = await publishAssessment(ctx.db, {
      publicationKey: `synthetic-legacy:${mail.id}`,
      family: "email_relevance",
      subject: {
        kind: "email_relevance",
        entity: "email",
        recordId: mail.id,
        checksum: mail.checksum!,
        observationId: crypto.randomUUID(),
      },
      judgment: { classification: "unrelated", stage: "decision" },
      producer: null,
      fingerprint: mail.checksum,
      evidence: null,
    });
    const legacyHistory = await listAutomaticDecisions(ctx.db, {
      family: "email_relevance",
      recordIds: [mail.shortcode],
    });
    expect(
      legacyHistory.items.find((row) => row.id === legacy.id),
    ).toMatchObject({
      applicationVerified: false,
      decision: { classification: "unrelated", stage: "decision" },
    });
    const pending = await listSuggestionPage(ctx.db, {});
    expect(pending.items.map((row) => row.assessmentId)).not.toContain(
      outcome.id,
    );
    expect(pending.items.map((row) => row.assessmentId)).not.toContain(
      legacy.id,
    );
    for (const codes of [
      [mail.shortcode],
      [fixture.order.shortcode],
      [mail.shortcode, fixture.order.shortcode],
    ]) {
      const audit = await listAutomaticDecisions(ctx.db, {
        family: "email_link",
        recordIds: codes,
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
        recordIds: codes,
      });
      expect(
        outcomes.items.filter((row) => row.id === outcome.id),
      ).toHaveLength(1);
      expect(
        outcomes.items.find((row) => row.id === outcome.id)?.records,
      ).toEqual(
        expect.arrayContaining([
          { entity: "email", id: mail.shortcode },
          { entity: "purchase", id: fixture.order.shortcode },
        ]),
      );
    }
    for (const family of ["email_link", "mail_import_outcome"] as const) {
      expect(
        (
          await listAutomaticDecisions(ctx.db, {
            family,
            recordIds: [fixture.party.shortcode],
          })
        ).items,
      ).toEqual([]);
    }
  });
  it("captures external bytes obtained by existing retention staging", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic staged member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    let fetched = 0;
    const payload = Buffer.from("Synthetic staged bytes");
    await ingestGmailMessages(
      ctx.db,
      {
        ...gmail,
        getMessage: async (id) => ({
          id,
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "text/plain",
                body: {
                  data: Buffer.from("Synthetic receipt").toString("base64url"),
                },
              },
              {
                mimeType: "application/pdf",
                filename: "synthetic.pdf",
                body: {
                  attachmentId: "synthetic-attachment",
                  size: payload.length,
                },
              },
            ],
          },
        }),
        getAttachment: async () => {
          fetched += 1;
          return { data: payload.toString("base64url"), size: payload.length };
        },
      },
      {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-staged-mailbox",
        messageIds: ["synthetic-staged-message"],
        storage,
        triage: async () => "related",
      },
    );
    const [observation] = await getDb(ctx.db)
      .select()
      .from(emailClassificationObservation);
    if (!observation) throw new Error("Synthetic staged observation missing");
    expect(
      (await ensureEmailAssessment(ctx.db, observation.id)).evidence,
    ).toMatchObject({ originalCapture: { status: "complete" } });
    expect(fetched).toBe(1);
  });
  it("keeps new original proof immutable and rejects a different publication binding", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic capture member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const mail = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      provider: "gmail",
      mailboxId: "synthetic-capture-mailbox",
      messageId: "synthetic-capture-message",
      checksum: "synthetic-legacy-checksum",
      status: "pending",
    });
    const input = {
      emailId: mail.id,
      checksum: "synthetic-legacy-checksum",
      classification: "uncertain" as const,
      stage: "decision" as const,
      reason: "Synthetic observation",
      classificationVersion: "synthetic-v1",
    };
    const legacy = await recordEmailClassificationObservation(ctx.db, input);
    const legacyAssessment = await ensureEmailAssessment(ctx.db, legacy.id);
    const originalCapture = await captureGmailOriginal({
      ledgerPartyId: party.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      message: await gmail.getMessage(mail.messageId),
    });
    const captured = await recordEmailClassificationObservation(
      ctx.db,
      input,
      undefined,
      { originalCapture },
    );
    expect(captured.id).not.toBe(legacy.id);
    expect((await ensureEmailAssessment(ctx.db, legacy.id)).evidence).toEqual(
      legacyAssessment.evidence,
    );
    expect(
      (await ensureEmailAssessment(ctx.db, captured.id)).evidence,
    ).toMatchObject({ originalCapture });
    expect(
      (
        await recordEmailClassificationObservation(ctx.db, input, undefined, {
          originalCapture,
        })
      ).id,
    ).toBe(captured.id);
    await expect(
      recordEmailClassificationObservation(ctx.db, input, undefined, {
        originalCapture: {
          ...originalCapture,
          binding: {
            ...originalCapture.binding,
            mailboxId: "synthetic-other-mailbox",
          },
        },
      }),
    ).rejects.toThrow("does not match");
    expect(
      await getDb(ctx.db)
        .select()
        .from(emailClassificationObservation)
        .where(eq(emailClassificationObservation.emailId, mail.id)),
    ).toHaveLength(2);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(emailTable)
          .where(eq(emailTable.id, mail.id))
      )[0]?.classification,
    ).toBeNull();
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
      relevance: async () => ({ classification: "uncertain" as const }),
    };
    await ingestGmailMessages(ctx.db, gmail, input);
    const [email] = await getDb(ctx.db).select().from(emailTable);
    const predictions = await getDb(ctx.db)
      .select()
      .from(emailClassificationObservation);
    expect(predictions).toHaveLength(1);
    const prediction = predictions[0];
    if (!email || !prediction) throw new Error("Synthetic prediction missing");
    expect(
      (await ensureEmailAssessment(ctx.db, prediction.id)).evidence,
    ).toMatchObject({
      originalCapture: {
        status: "complete",
        version: "gmail-original-v1",
        binding: {
          ledgerPartyId: party.id,
          mailboxId: input.mailboxId,
          messageId: input.messageIds[0],
        },
      },
    });
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
        decision: { classification: "uncertain", stage: "model" },
      }),
    ]);
    expect(prediction).toMatchObject({
      emailId: email.id,
      classification: "uncertain",
      stage: "model",
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
        searchActor: ctx.actor,
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
