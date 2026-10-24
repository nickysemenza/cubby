import { emailReviewFrontierReceipt } from "@cubby/schemas/email-observations";
import { emailId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { withConnection } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { assessmentState, feedback, ledgerParty } from "~/server/db/schema";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import {
  publishAssessment,
  recordFeedback,
} from "~/server/generic/assessment/repo/assessment";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { withEmailEvidenceWrite } from "./email-evidence-write-scope";
import { readEmailProtectingIntent } from "./email-review-intent";

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
      publishAssessment(ctx.db, {
        publicationKey: `synthetic-email-intent:${crypto.randomUUID()}`,
        family: "email_relevance",
        subject: {
          kind: "email_relevance",
          entity: "email",
          recordId: mail.id,
          checksum,
          observationId: crypto.randomUUID(),
        },
        judgment: { classification: "uncertain", stage: "decision" },
        producer: null,
        fingerprint: checksum,
        evidence: null,
      });
    const prediction = await publish(mail.checksum ?? "synthetic-current");
    const input = {
      assessmentId: prediction.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "history",
    } as const;
    return { mail, prediction, publish, input };
  }

  it("refuses member Email review inside an unscoped transaction before retaining intent", async () => {
    const f = await fixture();
    await withTransactionDatabase(ctx.db, async (db) => {
      await expect(
        reviewAssessment(db, kernelCtx(ctx), f.input),
      ).rejects.toThrow("root Database");
    });
    expect(await getDb(ctx.db).select().from(feedback)).toEqual([]);
  });

  it("serializes concurrent member command frontiers before Feedback insertion", async () => {
    const f = await fixture();
    const newer = await f.publish("synthetic-other-checksum");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = withEmailEvidenceWrite(ctx.db, async (db, scope) => {
      const result = await reviewAssessment(
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
      return reviewAssessment(connection, kernelCtx(ctx), {
        ...f.input,
        assessmentId: newer.id,
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
      expect(
        await getDb(ctx.db)
          .select()
          .from(feedback)
          .where(eq(feedback.assessmentId, newer.id)),
      ).toEqual([]);
    } finally {
      release.resolve();
    }
    const [a, b] = await Promise.all([first, second]);
    const events = await getDb(ctx.db).select().from(feedback);
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
    const old = await recordFeedback(ctx.db, {
      assessmentId: previous.id,
      operationId: "synthetic-old-review",
      verdict: "wrong",
      authority: "member",
      actorUserId: ctx.actor.userId,
      intent: "history",
    });
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ active: false })
      .where(eq(assessmentState.id, previous.id));
    const resolution = await recordFeedback(ctx.db, {
      assessmentId: previous.id,
      operationId: "resolution",
      verdict: "correct",
      authority: "automatic",
      actorUserId: null,
      intent: "apply",
      metadata: { kind: "email_resolution" },
    });
    const model = await recordFeedback(ctx.db, {
      assessmentId: previous.id,
      operationId: "classification-observed",
      verdict: "ungraded",
      authority: "automatic",
      actorUserId: null,
      intent: "history",
    });
    const result = await reviewAssessment(ctx.db, kernelCtx(ctx), f.input);
    const events = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, f.prediction.id));
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
    const newer = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      ...f.input,
      assessmentId: later.id,
      operationId: crypto.randomUUID(),
    });
    expect(await reviewAssessment(ctx.db, kernelCtx(ctx), f.input)).toEqual(
      result,
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(feedback)
        .where(eq(feedback.assessmentId, f.prediction.id)),
    ).toEqual(events);
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
      reviewAssessment(ctx.db, kernelCtx(ctx), {
        ...f.input,
        verdict: "correct",
      }),
    ).rejects.toThrow("Immutable Feedback retry");
  });

  it("retains link decisions and validates Email/Purchase connection endpoints", async () => {
    const f = await fixture();
    const link = await publishAssessment(ctx.db, {
      publicationKey: "synthetic-intent-link",
      family: "email_link",
      subject: {
        kind: "email_link",
        entity: "email",
        recordId: f.mail.id,
        originalId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        purchaseId: crypto.randomUUID(),
        checksum: "synthetic-old-checksum",
      },
      judgment: { decision: "dismissed" },
      producer: null,
      fingerprint: "synthetic-link",
      evidence: null,
    });
    const decision = await recordFeedback(ctx.db, {
      assessmentId: link.id,
      operationId: "decision",
      verdict: "dismissed",
      authority: "member",
      actorUserId: ctx.actor.userId,
      intent: "history",
      metadata: { kind: "email_link" },
    });
    const publishConnection = (source: string) =>
      publishAssessment(ctx.db, {
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
    const review = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      ...f.input,
      assessmentId: connection.id,
    });
    expect(
      await readEmailProtectingIntent(ctx.db, emailId.parse(f.mail.id)),
    ).toMatchObject({
      status: "captured",
      feedbackIds: expect.arrayContaining([decision.id, review.feedbackId]),
    });
    const ambiguous = await publishConnection("EML-ZZZZZ");
    await recordFeedback(ctx.db, {
      assessmentId: ambiguous.id,
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

  it("never reconstructs a legacy command baseline and commits capture atomically", async () => {
    const f = await fixture();
    const old = await recordFeedback(ctx.db, {
      ...f.input,
      authority: "member",
      actorUserId: ctx.actor.userId,
      metadata: {
        kind: "assessment_review",
        application: null,
        expectedFingerprint: null,
      },
    });
    await reviewAssessment(ctx.db, kernelCtx(ctx), f.input);
    const before = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, f.prediction.id));
    expect(before.some((row) => row.id === old.id)).toBe(true);
    expect(
      before.find(
        (row) => row.operationId === `email-review-frontier:${old.id}`,
      ),
    ).toBeUndefined();
    await expect(
      withEmailEvidenceWrite(ctx.db, async (db, scope) => {
        await reviewAssessment(
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
    expect(
      await getDb(ctx.db)
        .select()
        .from(feedback)
        .where(eq(feedback.assessmentId, f.prediction.id)),
    ).toEqual(before);
  });
});
