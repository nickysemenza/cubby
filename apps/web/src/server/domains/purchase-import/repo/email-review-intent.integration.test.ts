import { emailReviewFrontierReceipt } from "@cubby/schemas/email-observations";
import { emailId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { withConnection } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { emailReview, ledgerParty } from "~/server/db/schema";
import { appendEmailReview } from "~/server/domains/email/repo/email-review-store";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import {
  publishSuggestion,
  recordFeedback,
} from "~/server/generic/suggestions/repo/suggestion";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { withEmailEvidenceWrite } from "./email-evidence-write-scope";
import { readEmailProtectingIntent } from "./email-review-intent";
import { recordEmailClassificationObservation } from "./gmail/observations";

describe("command-bound Email intent frontier", () => {
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

  it("serializes concurrent member command frontiers before review insertion", async () => {
    const f = await fixture();
    const newer = await f.publish("synthetic-other-checksum");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = withEmailEvidenceWrite(ctx.db, async (db, scope) => {
      const result = await reviewSuggestion(
        db,
        kernelCtx(ctx),
        f.input,
        undefined,
        scope,
      );
      entered.resolve();
      await release.promise;
      return result;
    });
    await entered.promise;
    const started = Promise.withResolvers<number>();
    const second = withConnection(ctx.db, async (connection) => {
      const pid = z
        .object({ rows: z.array(z.object({ pid: z.number() })) })
        .parse(
          await getDb(connection).execute(sql`SELECT pg_backend_pid() AS pid`),
        ).rows[0]?.pid;
      if (!pid) throw new Error("Synthetic review connection missing PID");
      started.resolve(pid);
      return reviewSuggestion(connection, kernelCtx(ctx), {
        ...f.input,
        suggestionId: newer.id,
        operationId: "synthetic-second-command",
      });
    });
    const pid = await started.promise;
    try {
      await expect
        .poll(
          async () =>
            z
              .object({
                rows: z.array(z.object({ waiting: z.boolean().nullable() })),
              })
              .parse(
                await getDb(ctx.db).execute(
                  sql`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`,
                ),
              ).rows[0]?.waiting,
          { timeout: 2000 },
        )
        .toBe(true);
      expect(await reviewsOf(newer.id)).toEqual([]);
    } finally {
      release.resolve();
    }
    const [a, b] = await Promise.all([first, second]);
    const events = await getDb(ctx.db).select().from(emailReview);
    const capture = (id: string) =>
      emailReviewFrontierReceipt.parse(
        events.find(
          (event) => event.operationId === `email-review-frontier:${id}`,
        )?.receipt,
      ).frontier;
    expect(capture(a.feedbackId)).toMatchObject({
      status: "captured",
      feedbackIds: [a.feedbackId],
    });
    expect(capture(b.feedbackId)).toMatchObject({
      status: "captured",
      feedbackIds: expect.arrayContaining([a.feedbackId, b.feedbackId]),
    });
  });

  it("captures retained history with the new command and preserves its exact baseline on replay", async () => {
    const f = await fixture();
    const previous = await f.publish("synthetic-old-checksum");
    const old = await retained(f.mail, previous.id, {
      operationId: "synthetic-old-review",
      authority: "member",
      actorUserId: ctx.actor.userId,
    });
    const resolution = await retained(f.mail, previous.id, {
      operationId: "resolution",
      authority: "automatic",
      actorUserId: null,
      metadata: { kind: "email_resolution" },
    });
    const model = await retained(f.mail, previous.id, {
      operationId: "classification-observed",
      authority: "automatic",
      actorUserId: null,
    });
    const result = await reviewSuggestion(ctx.db, kernelCtx(ctx), f.input);
    const events = await reviewsOf(f.prediction.id);
    const capture = events.find(
      (row) => row.operationId === `email-review-frontier:${result.feedbackId}`,
    );
    expect(capture).toMatchObject({
      authority: "system",
      intent: "history",
      actorUserId: null,
    });
    const proof = emailReviewFrontierReceipt.parse(capture?.receipt);
    expect(proof.commandFeedbackId).toBe(result.feedbackId);
    expect(proof.frontier).toEqual({
      status: "captured",
      emailId: f.mail.id,
      feedbackIds: [old.id, resolution.id, result.feedbackId].sort(),
    });
    expect(JSON.stringify(proof)).not.toContain(model.id);
    const later = await f.publish("synthetic-current");
    const newer = await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      ...f.input,
      suggestionId: later.id,
      operationId: crypto.randomUUID(),
    });
    expect(await reviewSuggestion(ctx.db, kernelCtx(ctx), f.input)).toEqual(
      result,
    );
    expect(await reviewsOf(f.prediction.id)).toEqual(events);
    expect(JSON.stringify(proof)).not.toContain(newer.feedbackId);
    const current = await readEmailProtectingIntent(
      ctx.db,
      emailId.parse(f.mail.id),
    );
    expect(current).toMatchObject({
      status: "captured",
      feedbackIds: expect.arrayContaining([newer.feedbackId]),
    });
    await expect(
      reviewSuggestion(ctx.db, kernelCtx(ctx), {
        ...f.input,
        verdict: "correct",
      }),
    ).rejects.toThrow("Immutable Email review retry");
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
      publishSuggestion(ctx.db, {
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

  it("commits a review and its frontier capture atomically", async () => {
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
        throw new Error("Synthetic abort after capture");
      }),
    ).rejects.toThrow("Synthetic abort after capture");
    expect(await reviewsOf(f.prediction.id)).toEqual(before);
  });
});
