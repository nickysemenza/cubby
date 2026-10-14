import { feedbackVerdict } from "@cubby/schemas/assessment";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { assessment, assessmentState, feedback } from "~/server/db/schema";
import { publishAssessment, recordFeedback } from "~/server/repo/assessment";
import { reviewAssessment } from "~/server/repo/assessment-review";
import { getDb } from "~/server/repo/database-helpers";
import {
  kernelCtx,
  productFixture,
} from "~/server/runs/suggestion-sweep.fixtures";

// Failure modes: retry publication mutates historical evidence; corrected null
// disappears; bare wrong becomes suppression; deleting active targets deletes
// history; evaluation feedback acquires operational authority.
describe("shared Assessment history", () => {
  const ctx = withTestDb();
  const publication = () => ({
    publicationKey: "synthetic:assessment:retry",
    family: "recommendation" as const,
    subject: {
      kind: "recommendation" as const,
      entity: "product",
      recordId: parseEntityId(
        "product",
        "00000000-0000-4000-8000-000000000001",
      ),
      candidateKey: "synthetic-key",
      scope: "related",
    },
    judgment: { candidateKey: "synthetic-key" },
    fingerprint: null,
    producer: null,
    evidence: null,
  });

  it("publishes once and refuses changed evidence under a retry identity", async () => {
    const first = await publishAssessment(ctx.db, publication());
    expect((await publishAssessment(ctx.db, publication())).id).toBe(first.id);
    await expect(
      publishAssessment(ctx.db, {
        ...publication(),
        evidence: { changed: true },
      }),
    ).rejects.toThrow(/publication/);
    await expect(
      getDb(ctx.db)
        .update(assessment)
        .set({ judgment: { changed: true } })
        .where(eq(assessment.id, first.id)),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/immutable/), code: "P0001" },
    });
  });

  it("records draft acceptance separately and acknowledges only the matching saved field", async () => {
    const record = await productFixture(ctx, "Synthetic receipt item", {
      notes: "Saved synthetic note",
    });
    const prediction = await publishAssessment(ctx.db, {
      publicationKey: "synthetic:draft-receipt",
      family: "field",
      subject: {
        kind: "field",
        entity: "product",
        recordId: null,
        field: "notes",
        draft: true,
      },
      judgment: { value: "Saved synthetic note" },
      producer: null,
      fingerprint: "synthetic-draft-evidence",
      evidence: null,
    });
    const context = kernelCtx(ctx);
    expect(
      (
        await reviewAssessment(ctx.db, context, {
          assessmentId: prediction.id,
          operationId: "draft",
          verdict: "correct",
          intent: "draft",
        })
      ).applied,
    ).toBe(false);
    expect(
      (
        await reviewAssessment(ctx.db, context, {
          assessmentId: prediction.id,
          operationId: "saved",
          verdict: "correct",
          intent: "apply",
          application: { kind: "saved_field", recordId: record.id },
        })
      ).applied,
    ).toBe(true);
    const rows = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, prediction.id));
    expect(rows.find((row) => row.operationId === "draft")?.receipt).toBeNull();
    expect(
      rows.find((row) => row.operationId === "receipt:saved")?.receipt,
    ).toEqual(
      expect.objectContaining({ mode: "member", reason: "member_acceptance" }),
    );
    const changed = await productFixture(ctx, "Synthetic changed receipt", {
      notes: "A different saved note",
    });
    await expect(
      reviewAssessment(ctx.db, context, {
        assessmentId: prediction.id,
        operationId: "saved",
        verdict: "correct",
        intent: "apply",
        application: { kind: "saved_field", recordId: changed.id },
      }),
    ).rejects.toThrow(/Immutable Feedback retry/);
    await expect(
      reviewAssessment(ctx.db, context, {
        assessmentId: prediction.id,
        operationId: "changed",
        verdict: "correct",
        intent: "apply",
        application: { kind: "saved_field", recordId: changed.id },
      }),
    ).rejects.toThrow(/saved field/);
  });

  it("retains corrected null and separates wrong from presentation suppression", async () => {
    const first = await publishAssessment(ctx.db, publication());
    await recordFeedback(ctx.db, {
      assessmentId: first.id,
      operationId: "synthetic-review",
      verdict: "wrong",
      correction: { present: true, value: null },
      intent: "history",
      reason: null,
      evidence: null,
      authority: "member",
      actorUserId: null,
    });
    const [review] = await getDb(ctx.db).select().from(feedback);
    expect(review?.correction).toEqual({ present: true, value: null });
    const [current] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, first.id));
    expect(current?.suppression).toBeNull();
    await getDb(ctx.db)
      .delete(assessmentState)
      .where(eq(assessmentState.id, first.id));
    expect((await getDb(ctx.db).select().from(assessment)).length).toBe(1);
    expect((await getDb(ctx.db).select().from(feedback)).length).toBe(1);
    await expect(
      getDb(ctx.db).execute(
        sql`UPDATE "Feedback" SET verdict = ${feedbackVerdict.enum.correct}`,
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/immutable/), code: "P0001" },
    });
  });
});
