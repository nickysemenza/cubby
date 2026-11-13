import { emailId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { emailReview, ledgerParty } from "~/server/db/schema";
import { appendEmailReview } from "~/server/domains/email/repo/email-review-store";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import { recordFeedback } from "~/server/generic/suggestions/repo/suggestion";
import { publishExactSuggestion } from "~/server/generic/suggestions/repo/suggestion-publication";

import { withEmailEvidenceWrite } from "./email-evidence-write-scope";
import { readEmailProtectingIntent } from "./email-review-intent";
import { recordEmailClassificationObservation } from "./gmail/observations";

describe("Email review transaction and retained intent", () => {
  const ctx = withTestDb();
  async function fixture() {
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic intent member",
      kind: "member",
    });
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ userId: ctx.actor.userId })
      .where(eq(ledgerParty.id, owner.entityId));
    const mail = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: owner.entityId,
      provider: "gmail",
      mailboxId: "synthetic-intent-mailbox",
      messageId: crypto.randomUUID(),
      checksum: "synthetic-current",
      status: "pending",
    });
    const publish = (checksum: string) =>
      recordEmailClassificationObservation(ctx.db, {
        emailId: mail.id,
        checksum,
        classification: "uncertain",
        stage: "decision",
        reason: `Synthetic prediction ${checksum}`,
        classificationVersion: "synthetic-v1",
      });
    const prediction = await publish(mail.checksum ?? "synthetic-current");
    const input = {
      suggestionId: prediction.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "history",
    } as const;
    return { mail, prediction, publish, input };
  }
  const reviewsOf = (subjectId: string) =>
    getDb(ctx.db)
      .select()
      .from(emailReview)
      .where(eq(emailReview.subjectId, subjectId));
  const retained = (
    mail: { id: string },
    subjectId: string,
    input: {
      operationId: string;
      authority: "member" | "automatic";
      actorUserId: string | null;
      metadata?: unknown;
      family?: "email_relevance" | "email_link";
      subject?: unknown;
    },
  ) =>
    appendEmailReview(ctx.db, {
      family: input.family ?? "email_relevance",
      subjectId,
      emailId: mail.id,
      originalId: null,
      checksum: null,
      operationId: input.operationId,
      verdict: "wrong",
      intent: "history",
      authority: input.authority,
      actorUserId: input.actorUserId,
      subject: z.json().parse(
        input.subject ?? {
          kind: "email_relevance",
          entity: "email",
          recordId: mail.id,
          checksum: "synthetic-old-checksum",
          observationId: subjectId,
        },
      ),
      metadata: input.metadata,
    });

  it("refuses member Email review inside an unscoped transaction before retaining intent", async () => {
    const f = await fixture();
    await withTransactionDatabase(ctx.db, async (db) => {
      await expect(
        reviewSuggestion(db, kernelCtx(ctx), f.input),
      ).rejects.toThrow("root Database");
    });
    expect(await getDb(ctx.db).select().from(emailReview)).toEqual([]);
  });

  it("retains link decisions and validates Email/Purchase connection endpoints", async () => {
    const f = await fixture();
    const decision = await retained(f.mail, crypto.randomUUID(), {
      operationId: "decision",
      family: "email_link",
      authority: "member",
      actorUserId: ctx.actor.userId,
      metadata: { kind: "email_link" },
      subject: {
        kind: "email_link",
        entity: "email",
        recordId: f.mail.id,
        originalId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        purchaseId: crypto.randomUUID(),
        checksum: "synthetic-old-checksum",
      },
    });
    const publishConnection = (source: string) =>
      publishExactSuggestion(ctx.db, {
        publicationKey: `synthetic-connection:${source}`,
        family: "recommendation",
        subject: {
          kind: "recommendation",
          entity: "email",
          recordId: f.mail.id,
          scope: "connection.email-purchase",
          candidateKey: source,
        },
        judgment: { candidateKey: source },
        producer: null,
        fingerprint: source,
        evidence: {
          candidate: {
            relation: "email-purchase",
            source: { entityKind: "email", entityId: source },
            target: { entityKind: "purchase", entityId: "PUR-AAAAA" },
            label: "Synthetic link",
            evidence: { reasons: [], contradictions: [], unknowns: [] },
          },
        },
      });
    const connection = await publishConnection(f.mail.shortcode);
    const review = await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      ...f.input,
      suggestionId: connection.id,
    });
    expect(
      await readEmailProtectingIntent(ctx.db, emailId.parse(f.mail.id)),
    ).toMatchObject({
      status: "captured",
      feedbackIds: expect.arrayContaining([decision.id, review.feedbackId]),
    });
    const ambiguous = await publishConnection("EML-ZZZZZ");
    await recordFeedback(ctx.db, {
      suggestionId: ambiguous.id,
      operationId: "synthetic-legacy-connection",
      verdict: "wrong",
      authority: "member",
      actorUserId: ctx.actor.userId,
      intent: "history",
    });
    expect(
      await readEmailProtectingIntent(ctx.db, emailId.parse(f.mail.id)),
    ).toMatchObject({
      status: "held",
      reason: expect.stringContaining("endpoint proof"),
    });
  });

  it("rolls back an aborted review atomically", async () => {
    const f = await fixture();
    await reviewSuggestion(ctx.db, kernelCtx(ctx), f.input);
    const before = await reviewsOf(f.prediction.id);
    await expect(
      withEmailEvidenceWrite(ctx.db, async (db, scope) => {
        await reviewSuggestion(
          db,
          kernelCtx(ctx),
          {
            ...f.input,
            operationId: "synthetic-aborted-command",
          },
          undefined,
          scope,
        );
        throw new Error("Synthetic abort after review");
      }),
    ).rejects.toThrow("Synthetic abort after review");
    expect(await reviewsOf(f.prediction.id)).toEqual(before);
  });
});
