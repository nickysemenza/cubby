import { feedbackVerdict } from "@cubby/schemas/assessment";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  assessment,
  assessmentState,
  feedback,
  auditLog,
} from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import { publishAssessment, recordFeedback } from "~/server/repo/assessment";
import { readConfirmedDescription } from "~/server/repo/assessment-image";
import { assessRecommendation } from "~/server/repo/assessment-recommendation";
import { reviewAssessment } from "~/server/repo/assessment-review";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  kernelCtx,
  productFixture,
  recordId,
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

  // Command replay must outlive projection resolution; another command cannot inherit success.
  it.each([false, true])(
    "replays the exact field application once, correction=%s",
    async (corrected) => {
      const product = await productFixture(ctx, "Synthetic command replay", {
        notes: "Original note",
      });
      const target = await recordId(ctx.db, product.id, "product");
      const prediction = await publishAssessment(
        ctx.db,
        {
          publicationKey: "synthetic:field-replay",
          family: "field",
          subject: {
            kind: "field",
            entity: "product",
            recordId: target,
            field: "notes",
          },
          judgment: { value: "Proposed note" },
          fingerprint: null,
          producer: null,
          evidence: null,
        },
        {
          suggestedValue: "Proposed note",
          currentValue: "Original note",
          confidence: 1,
        },
      );
      const command = {
        assessmentId: prediction.id,
        operationId: "synthetic:apply-once",
        verdict: corrected ? ("wrong" as const) : ("correct" as const),
        intent: "apply" as const,
        correction: corrected
          ? { present: true as const, value: "Corrected note" }
          : { present: false as const },
      };
      const first = await reviewAssessment(ctx.db, kernelCtx(ctx), command);
      const history = await getDb(ctx.db).select().from(feedback);
      const audit = await getDb(ctx.db).select().from(auditLog);
      expect(await reviewAssessment(ctx.db, kernelCtx(ctx), command)).toEqual(
        first,
      );
      expect(await getDb(ctx.db).select().from(feedback)).toEqual(history);
      expect(await getDb(ctx.db).select().from(auditLog)).toEqual(audit);
      await expect(
        reviewAssessment(ctx.db, kernelCtx(ctx), {
          ...command,
          correction: { present: true, value: "Conflicting reuse" },
        }),
      ).rejects.toThrow(/Immutable Feedback retry/);
      await expect(
        reviewAssessment(ctx.db, kernelCtx(ctx), {
          ...command,
          operationId: "synthetic:another-command",
          correction: { present: true, value: "Another correction" },
        }),
      ).rejects.toThrow(/resolved/);
    },
  );
  it("replays an image confirmation without allowing another operation to reuse its success", async () => {
    const picture = await insertWithShortcode(ctx.db, "image", {
      key: "synthetic/replay.jpg",
      filename: "replay.jpg",
      size: 1,
      contentType: "image/jpeg",
      sha256: "a".repeat(64),
    });
    const prediction = await publishAssessment(ctx.db, {
      publicationKey: "synthetic:image-replay",
      family: "image_description",
      subject: {
        kind: "image_description",
        entity: "image",
        recordId: picture.id,
        contentHash: picture.sha256,
      },
      judgment: "Original image text",
      fingerprint: picture.sha256,
      producer: null,
      evidence: null,
    });
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ createdAt: new Date("2000-01-01T00:00:00Z") })
      .where(eq(assessmentState.id, prediction.id));
    const command = {
      assessmentId: prediction.id,
      operationId: "synthetic:image-command",
      verdict: "wrong" as const,
      intent: "apply" as const,
      correction: { present: true as const, value: "Confirmed image text" },
    };
    const first = await reviewAssessment(ctx.db, kernelCtx(ctx), command);
    expect(await reviewAssessment(ctx.db, kernelCtx(ctx), command)).toEqual(
      first,
    );
    expect(
      (
        await readConfirmedDescription(
          ctx.db,
          parseEntityId("image", picture.id),
        )
      )?.confirmedAt.getTime(),
    ).toBeGreaterThan(new Date("2000-01-01T00:00:00Z").getTime());
    const confirmedAt = (
      await readConfirmedDescription(ctx.db, parseEntityId("image", picture.id))
    )?.confirmedAt;
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), {
        ...command,
        operationId: "synthetic:new-image-command",
        correction: { present: true, value: "Later text" },
      }),
    ).rejects.toThrow(/resolved/);
    // The test transaction freezes now(); retain an explicitly later failed grade.
    await getDb(ctx.db)
      .insert(feedback)
      .values({
        assessmentId: prediction.id,
        operationId: "synthetic:later-failed-grade",
        verdict: "wrong",
        intent: "apply",
        authority: "member",
        correction: { present: true, value: "Unapplied text" },
        createdAt: new Date("2030-01-01T00:00:00Z"),
      });
    expect(
      (
        await readConfirmedDescription(
          ctx.db,
          parseEntityId("image", picture.id),
        )
      )?.confirmedAt,
    ).toEqual(confirmedAt);
  });

  // Public history must never impersonate a private domain-application receipt.
  it("refuses public receipt namespace collisions and forged application receipts", async () => {
    const picture = await insertWithShortcode(ctx.db, "image", {
      key: "synthetic/receipt-collision.jpg",
      filename: "receipt-collision.jpg",
      size: 1,
      contentType: "image/jpeg",
      sha256: "b".repeat(64),
    });
    const prediction = await publishAssessment(ctx.db, {
      publicationKey: "synthetic:receipt-collision",
      family: "image_description",
      subject: {
        kind: "image_description",
        entity: "image",
        recordId: picture.id,
        contentHash: picture.sha256,
      },
      judgment: "Synthetic image description",
      fingerprint: picture.sha256,
      producer: null,
      evidence: null,
    });
    for (const operationId of [
      "command-application:synthetic-command",
      "receipt:synthetic-command",
      "application:synthetic-command",
      "merge:synthetic-command",
      "email-accuracy:synthetic-command",
      "decision",
      "resolution",
      "saved-application",
      "saved-correction",
    ]) {
      await expect(
        reviewAssessment(ctx.db, kernelCtx(ctx), {
          assessmentId: prediction.id,
          operationId,
          verdict: "uncertain",
          intent: "history",
        }),
      ).rejects.toThrow(/reserved/);
    }
    // Also fail closed for a pre-existing collision written before public validation.
    await recordFeedback(ctx.db, {
      assessmentId: prediction.id,
      operationId: "command-application:synthetic-command",
      verdict: "uncertain",
      intent: "history",
      authority: "member",
      actorUserId: ctx.actor.userId,
    });
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: prediction.id,
        operationId: "synthetic-command",
        verdict: "correct",
        intent: "apply",
      }),
    ).rejects.toThrow(/receipt/);
    expect(
      await readConfirmedDescription(
        ctx.db,
        parseEntityId("image", picture.id),
      ),
    ).toBeNull();
    const applied = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: prediction.id,
      operationId: "synthetic-genuine-command",
      verdict: "correct",
      intent: "apply",
    });
    expect(applied.applied).toBe(true);
    expect(
      (
        await readConfirmedDescription(
          ctx.db,
          parseEntityId("image", picture.id),
        )
      )?.description,
    ).toBe("Synthetic image description");
  });

  it("retires a nonsearchable category projection while retaining immutable history", async () => {
    const category = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic retired category",
    });
    const prediction = await publishAssessment(ctx.db, {
      ...publication(),
      publicationKey: "synthetic:category-lifecycle",
      subject: {
        ...publication().subject,
        entity: "productCategory",
        recordId: category.id,
      },
    });
    await executeEntity(kernelCtx(ctx), {
      action: "delete",
      entity: "productCategory",
      ids: [parseShortcodeFor("productCategory", category.shortcode)],
    });
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(assessmentState)
          .where(eq(assessmentState.id, prediction.id))
      )[0],
    ).toMatchObject({ active: false, status: "superseded" });
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(assessment)
          .where(eq(assessment.id, prediction.id))
      )[0]?.subject,
    ).toEqual(prediction.subject);
  });
  it("refuses invalid draft and saved intents before recording Feedback", async () => {
    const prediction = await publishAssessment(ctx.db, publication());
    for (const command of [
      { intent: "draft" as const },
      {
        intent: "apply" as const,
        application: { kind: "saved_field" as const, recordId: "PRD-4K7M" },
      },
    ])
      await expect(
        reviewAssessment(ctx.db, kernelCtx(ctx), {
          assessmentId: prediction.id,
          operationId: "synthetic:invalid",
          verdict: "wrong",
          correction: { present: true, value: "Synthetic invalid correction" },
          ...command,
        }),
      ).rejects.toThrow(/field Assessment/);
    expect(await getDb(ctx.db).select().from(feedback)).toEqual([]);
  });

  it("reuses a recommendation publication on unchanged repeated reads", async () => {
    const product = await productFixture(
      ctx,
      "Synthetic repeat recommendation",
    );
    const first = await assessRecommendation(
      ctx.db,
      product.id,
      "synthetic.related",
      ["same-candidate"],
      { evidence: "same" },
    );
    expect(
      await assessRecommendation(
        ctx.db,
        product.id,
        "synthetic.related",
        ["same-candidate"],
        { evidence: "same" },
      ),
    ).toEqual(first);
    expect(await getDb(ctx.db).select().from(assessment)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(assessmentState)).toHaveLength(1);
  });

  it("retains corrected null and separates wrong from presentation suppression", async () => {
    const record = await productFixture(ctx, "Synthetic history subject");
    const subjectId = await recordId(ctx.db, record.id, "product");
    const original = publication();
    const first = await publishAssessment(ctx.db, {
      ...original,
      subject: { ...original.subject, recordId: subjectId },
    });
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
    await executeEntity(kernelCtx(ctx), {
      action: "delete",
      entity: "product",
      ids: [record.id],
    });
    const [retired] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, first.id));
    expect(retired).toMatchObject({
      active: false,
      status: "superseded",
      suppression: null,
    });
    expect((await getDb(ctx.db).select().from(assessment)).length).toBe(1);
    expect(
      (await getDb(ctx.db).select().from(assessment))[0]?.subject,
    ).toMatchObject({ recordId: subjectId });
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
