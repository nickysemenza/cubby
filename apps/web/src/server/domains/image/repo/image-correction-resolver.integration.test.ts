import { parseEntityId } from "@cubby/schemas/identifiers";
import { imageDescriptionCorrectionOwner } from "@cubby/schemas/image-processing";
import { enrollSuggestionCorrectionsInput } from "@cubby/schemas/suggestion-correction";
import { and, eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getProductClassificationEvidence } from "~/server/db/computed/product-classification-evidence";
import { getDb, withSnapshotWriteDatabase } from "~/server/db/helpers";
import { image, assessmentState, feedback, job } from "~/server/db/schema";
import { getImageProcessingReadProjection } from "~/server/domains/image-processing/repo/image-processing";
import {
  lockImageCorrectionContent,
  lockImageCorrectionRecord,
} from "~/server/domains/image/repo/image-correction-lock";
import { resolveImageCorrection } from "~/server/domains/image/repo/image-correction-resolver";
import { loadSelectedDescriptionEvidence } from "~/server/domains/image/repo/image-description-selection";
import { imageDescriptionCorrectionRepair } from "~/server/domains/image/repo/image-suggestion-correction";
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { readConfirmedDescription } from "~/server/generic/assessment/repo/assessment-image";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { enrollSuggestionCorrections } from "~/server/generic/assessment/repo/correction-enrollment";
import {
  readConfirmedCorrection,
  readCorrectionTarget,
} from "~/server/generic/assessment/repo/correction-sources";
import { enqueueCorrectionWork } from "~/server/generic/assessment/repo/correction-work";
import { correctionPropagationHandler } from "~/server/generic/assessment/service/correction-propagation";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { insertEntityAttachments } from "~/server/testing/repo.fixtures";

// Failure modes: a grade or stale confirmation becomes reusable authority;
// timestamps choose a winner among contradictory corrections of identical bytes.
describe("image correction authority", () => {
  const ctx = withTestDb();
  const hash = "a".repeat(64);

  async function question(
    key: string,
    existing?: Pick<typeof image.$inferSelect, "id" | "sha256">,
    contentHash: string | null = hash,
  ) {
    const picture =
      existing ??
      (await insertWithShortcode(ctx.db, "image", {
        key: `synthetic/${key}.jpg`,
        filename: `${key}.jpg`,
        size: 1,
        sha256: hash,
        contentType: "image/jpeg",
      }));
    const prediction = await publishAssessment(ctx.db, {
      publicationKey: `synthetic:image-correction:${key}`,
      family: "image_description",
      subject: {
        kind: "image_description",
        entity: "image",
        recordId: picture.id,
        contentHash,
      },
      judgment: "Synthetic model prose",
      fingerprint: contentHash,
      producer: {
        kind: "model",
        model: "synthetic",
        revision: "1",
        runId: null,
        evaluationId: null,
      },
      evidence: null,
    });
    return { picture, prediction };
  }

  async function correct(
    key: string,
    description: string,
    existing?: Pick<typeof image.$inferSelect, "id" | "sha256">,
  ) {
    const entry = await question(key, existing);
    const result = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: entry.prediction.id,
      operationId: `synthetic:correct:${key}`,
      verdict: "wrong",
      intent: "apply",
      correction: { present: true, value: description },
    });
    return { ...entry, result };
  }

  async function drain() {
    for (let page = 0; page < 10; page++) {
      const pending = await getDb(ctx.db)
        .select()
        .from(job)
        .where(
          and(
            eq(job.kind, "assessment.correction"),
            inArray(job.state, ["queued", "retry_wait"]),
          ),
        );
      if (!pending.length) return;
      for (const work of pending)
        expect(
          await advanceJob(ctx.db, work.id, {
            "assessment.correction": correctionPropagationHandler,
          }),
        ).toBe("succeeded");
    }
    throw new Error("Synthetic image correction jobs did not finish");
  }

  it("previews retained roots without writes and enrolls distinct history once without resetting completed jobs", async () => {
    const target = await question("retained-target");
    const root = await correct(
      "retained-root",
      "Synthetic retained correction",
    );
    // Simulate pre-adapter completed work; these operational records are immutable
    // inputs to enrollment, not jobs that the new operation may reset.
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "completed",
        result: { status: "held", reason: "Synthetic pre-adapter history" },
      })
      .where(eq(job.kind, "assessment.correction"));
    const original = await getDb(ctx.db).select().from(job);
    const previewInput = enrollSuggestionCorrectionsInput.parse({
      family: "image_description",
    });
    expect(
      await enrollSuggestionCorrections(ctx.db, previewInput),
    ).toMatchObject({
      dryRun: true,
      scanned: 1,
      receiptBackedRoots: 1,
      enrolledRoots: 0,
      done: true,
    });
    expect(await getDb(ctx.db).select().from(job)).toEqual(original);
    const applyInput = { ...previewInput, dryRun: false };
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        await enrollSuggestionCorrections(ctx.db, applyInput),
      ).toMatchObject({ enrolledRoots: 1 });
    const enrolled = await getDb(ctx.db).select().from(job);
    expect(enrolled).toHaveLength(original.length + 1);
    expect(
      enrolled.find((row) => !original.some((old) => old.id === row.id)),
    ).toMatchObject({
      key: `assessment-correction-history:image-description-v1:${root.result.feedbackId}`,
      state: "queued",
      input: {
        sourceFeedbackId: root.result.feedbackId,
        targetAssessmentId: null,
      },
    });
    await drain();
    expect(
      await readConfirmedDescription(
        ctx.db,
        parseEntityId("image", target.picture.id),
      ),
    ).toMatchObject({
      description: "Synthetic retained correction",
      owner: { kind: "correction" },
    });
    for (const old of original.filter(
      (row) => row.kind === "assessment.correction",
    ))
      expect(
        (await getDb(ctx.db).select().from(job).where(eq(job.id, old.id)))[0],
      ).toEqual(old);
    const completed = await getDb(ctx.db).select().from(job);
    await enrollSuggestionCorrections(ctx.db, applyInput);
    expect(await getDb(ctx.db).select().from(job)).toEqual(completed);
  });

  it("never restarts failed versioned enrollment on repeated execution", async () => {
    const root = await correct(
      "failed-enrollment-root",
      "Synthetic failed history correction",
    );
    const input = enrollSuggestionCorrectionsInput.parse({
      family: "image_description",
      dryRun: false,
    });
    await enrollSuggestionCorrections(ctx.db, input);
    const key = `assessment-correction-history:image-description-v1:${root.result.feedbackId}`;
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "failed",
        error: "Synthetic retained failure",
        attempts: 3,
      })
      .where(eq(job.key, key));
    const before = (
      await getDb(ctx.db).select().from(job).where(eq(job.key, key))
    )[0];
    expect(before).toMatchObject({ state: "failed", attempts: 3 });
    await enrollSuggestionCorrections(ctx.db, input);
    expect(
      (await getDb(ctx.db).select().from(job).where(eq(job.key, key)))[0],
    ).toEqual(before);
  });

  it("advances bounded enrollment past refused member applications without inventing authority", async () => {
    const refused = await question("refused-enrollment");
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "b".repeat(64) })
      .where(eq(image.id, parseEntityId("image", refused.picture.id)));
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: refused.prediction.id,
        operationId: "synthetic:refused-enrollment",
        verdict: "wrong",
        intent: "apply",
        correction: { present: true, value: "Synthetic refused correction" },
      }),
    ).rejects.toThrow("Image evidence changed before confirmation");
    await correct("valid-enrollment", "Synthetic valid correction");
    const jobsBefore = await getDb(ctx.db).select().from(job);
    let after: string | null = null;
    let scanned = 0;
    let roots = 0;
    let emptyCandidatePages = 0;
    for (let page = 0; page < 4; page++) {
      const result = await enrollSuggestionCorrections(
        ctx.db,
        enrollSuggestionCorrectionsInput.parse({
          family: "image_description",
          after,
          limit: 1,
        }),
      );
      scanned += result.scanned;
      roots += result.receiptBackedRoots;
      if (result.scanned && !result.receiptBackedRoots) emptyCandidatePages++;
      if (result.done) break;
      expect(result.after).not.toBe(after);
      after = result.after;
    }
    expect({ scanned, roots, emptyCandidatePages }).toEqual({
      scanned: 2,
      roots: 1,
      emptyCandidatePages: 1,
    });
    expect(await getDb(ctx.db).select().from(job)).toEqual(jobsBefore);
  });

  it.each(["historical", "future"])(
    "enrolls %s model descriptions and preserves correction precedence after later model publication",
    async (timing) => {
      const historical =
        timing === "historical" ? await question("historical-model") : null;
      const root = await correct(
        "enrollment-root",
        "Synthetic corrected image",
      );
      if (!historical) await drain();
      const target = historical ?? (await question("future-model"));
      await drain();
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(assessmentState)
            .where(eq(assessmentState.id, target.prediction.id))
        )[0]?.confirmedValue,
      ).toEqual({ present: true, value: "Synthetic corrected image" });
      const late = await question("late-model", target.picture);
      await drain();
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(assessmentState)
            .where(eq(assessmentState.id, late.prediction.id))
        )[0]?.status,
      ).toBe("superseded");
      expect(
        await readConfirmedDescription(
          ctx.db,
          parseEntityId("image", target.picture.id),
        ),
      ).toMatchObject({
        description: "Synthetic corrected image",
        owner: { kind: "correction", sourceFeedbackId: root.result.feedbackId },
      });
    },
  );

  it("settles two pending publications on one Image prepared in the same history page", async () => {
    const first = await question("same-page-first");
    const second = await question("same-page-second", first.picture);
    await correct("same-page-root", "Synthetic shared correction");
    await drain();
    const states = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(
        inArray(assessmentState.id, [
          first.prediction.id,
          second.prediction.id,
        ]),
      );
    expect(states.map((state) => state.status).sort()).toEqual([
      "applied",
      "superseded",
    ]);
    const outcomes = await getDb(ctx.db)
      .select({ receipt: feedback.receipt })
      .from(feedback)
      .where(
        and(
          inArray(feedback.assessmentId, [
            first.prediction.id,
            second.prediction.id,
          ]),
          eq(feedback.authority, "automatic"),
        ),
      );
    expect(outcomes).toHaveLength(2);
    expect(
      outcomes
        .map(
          (row) => z.object({ status: z.string() }).parse(row.receipt).status,
        )
        .sort(),
    ).toEqual(["applied", "unchanged"]);
  });

  it("applies and re-corrects untouched model text with durable automatic receipts, then replays without replacing the newer effect", async () => {
    const target = await question("automatic-target");
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic corrected image product",
    });
    await insertEntityAttachments(ctx.db, {
      entityId: product.id,
      imageId: target.picture.id,
      purpose: "item",
    });
    const root = await correct("automatic-root", "Synthetic apples");
    const source = await readConfirmedCorrection(
      ctx.db,
      root.result.feedbackId,
    );
    const original = await readCorrectionTarget(ctx.db, target.prediction.id);
    if (!source || !original)
      throw new Error("Missing synthetic correction inputs");
    const input = { source, target: original };
    const prepared = await imageDescriptionCorrectionRepair.prepare(
      ctx.db,
      input,
    );
    if (prepared.status !== "ready") throw new Error(prepared.reason);
    await enqueueCorrectionWork(
      ctx.db,
      source.feedbackId,
      target.prediction.id,
    );
    await drain();
    const first = (
      await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(eq(assessmentState.id, target.prediction.id))
    )[0];
    expect(first).toMatchObject({
      status: "applied",
      confirmedValue: { present: true, value: "Synthetic apples" },
      data: {
        confirmationOwner: {
          kind: "correction",
          sourceFeedbackId: source.feedbackId,
        },
      },
    });
    const [code] = await getDb(ctx.db)
      .select({ shortcode: image.shortcode })
      .from(image)
      .where(eq(image.id, target.picture.id));
    if (!code) throw new Error("Missing synthetic image shortcode");
    expect(
      (await loadSelectedDescriptionEvidence(ctx.db, [code.shortcode])).get(
        code.shortcode,
      ),
    ).toMatchObject({
      description: "Synthetic apples",
      authority: "correction",
      correction: { sourceFeedbackId: source.feedbackId },
      claims: [],
      analysis: null,
    });
    expect(
      await readConfirmedDescription(
        ctx.db,
        parseEntityId("image", target.picture.id),
      ),
    ).toMatchObject({
      owner: { kind: "correction", sourceFeedbackId: source.feedbackId },
    });
    expect(
      (
        await getImageProcessingReadProjection(
          ctx.db,
          parseEntityId("image", target.picture.id),
        )
      ).correction,
    ).toMatchObject({
      owner: { kind: "correction", sourceFeedbackId: source.feedbackId },
    });
    expect(
      await getProductClassificationEvidence(ctx.db, product.id),
    ).toContain("Synthetic apples");
    const replacement = await correct(
      "automatic-replacement",
      "Synthetic model prose",
      root.picture,
    );
    await enqueueCorrectionWork(
      ctx.db,
      replacement.result.feedbackId,
      target.prediction.id,
    );
    await drain();
    const changed = (
      await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(eq(assessmentState.id, target.prediction.id))
    )[0];
    expect(changed?.confirmedValue).toEqual({
      present: true,
      value: "Synthetic model prose",
    });
    expect(
      await withSnapshotWriteDatabase(
        ctx.db,
        (db) =>
          imageDescriptionCorrectionRepair.apply(
            db,
            input,
            prepared.plan,
            systemActor(),
          ),
        { isolationLevel: "serializable" },
      ),
    ).toMatchObject({ status: "applied" });
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(assessmentState)
          .where(eq(assessmentState.id, target.prediction.id))
      )[0],
    ).toEqual(changed);
    expect(
      await getDb(ctx.db)
        .select()
        .from(feedback)
        .where(
          and(
            eq(feedback.assessmentId, target.prediction.id),
            eq(feedback.authority, "automatic"),
          ),
        ),
    ).toHaveLength(2);
    const ownership = z
      .object({ confirmationOwner: imageDescriptionCorrectionOwner })
      .parse(changed?.data);
    await getDb(ctx.db)
      .update(assessmentState)
      .set({
        data: {
          confirmationOwner: {
            ...ownership.confirmationOwner,
            effectId: crypto.randomUUID(),
          },
        },
      })
      .where(eq(assessmentState.id, target.prediction.id));
    expect(
      await readConfirmedDescription(
        ctx.db,
        parseEntityId("image", target.picture.id),
      ),
    ).toBeNull();
    expect(
      (await loadSelectedDescriptionEvidence(ctx.db, [code.shortcode])).get(
        code.shortcode,
      )?.authority ?? "missing",
    ).toBe("missing");
    expect(
      await getProductClassificationEvidence(ctx.db, product.id),
    ).not.toContain("Synthetic model prose");
  });

  it("holds explicit target member intent and conflicting identical-content roots without assigning text", async () => {
    const target = await question("held-target");
    const root = await correct("held-root", "Synthetic apples");
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: target.prediction.id,
      operationId: "synthetic:target-intent",
      verdict: "wrong",
      intent: "history",
    });
    await enqueueCorrectionWork(
      ctx.db,
      root.result.feedbackId,
      target.prediction.id,
    );
    await drain();
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(assessmentState)
          .where(eq(assessmentState.id, target.prediction.id))
      )[0]?.confirmedValue,
    ).toBeNull();
    const untouched = await question("conflict-target");
    await correct("conflicting-root", "Synthetic pears");
    await enqueueCorrectionWork(
      ctx.db,
      root.result.feedbackId,
      untouched.prediction.id,
    );
    await drain();
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(assessmentState)
          .where(eq(assessmentState.id, untouched.prediction.id))
      )[0]?.confirmedValue,
    ).toBeNull();
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(feedback)
          .where(
            and(
              eq(feedback.assessmentId, untouched.prediction.id),
              eq(feedback.authority, "automatic"),
            ),
          )
      )[0]?.receipt,
    ).toMatchObject({
      status: "held",
      reason: "Identical image content has conflicting member corrections",
    });
  });

  it("requires committed application and drops changed or deleted content", async () => {
    const graded = await question("grade-only");
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: graded.prediction.id,
      operationId: "synthetic:grade-only",
      verdict: "wrong",
      intent: "history",
      correction: { present: true, value: "Synthetic corrected prose" },
    });
    expect(await resolveImageCorrection(ctx.db, hash)).toEqual({
      kind: "none",
    });
    const applied = await correct("applied", "Synthetic corrected prose");
    expect(await resolveImageCorrection(ctx.db, hash)).toMatchObject({
      kind: "confirmed",
      description: "Synthetic corrected prose",
      sources: [
        {
          feedbackId: applied.result.feedbackId,
          assessmentId: applied.prediction.id,
        },
      ],
    });
    expect(
      (
        await getDb(ctx.db)
          .select({ data: assessmentState.data })
          .from(assessmentState)
          .where(eq(assessmentState.id, applied.prediction.id))
      )[0]?.data,
    ).toMatchObject({
      confirmationOwner: {
        kind: "member",
        commandFeedbackId: applied.result.feedbackId,
      },
    });
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "b".repeat(64) })
      .where(eq(image.id, applied.picture.id));
    expect(await resolveImageCorrection(ctx.db, hash)).toEqual({
      kind: "none",
    });
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash, deletedAt: new Date() })
      .where(eq(image.id, applied.picture.id));
    expect(await resolveImageCorrection(ctx.db, hash)).toEqual({
      kind: "none",
    });
  });

  it("retires an earlier root when a fresh member correction replaces the same image's confirmed holder", async () => {
    const original = await correct("original", "Synthetic apples");
    const replacement = await correct(
      "replacement",
      "Synthetic pears",
      original.picture,
    );
    expect(await resolveImageCorrection(ctx.db, hash)).toMatchObject({
      kind: "confirmed",
      description: "Synthetic pears",
      sources: [{ feedbackId: replacement.result.feedbackId }],
    });
    const current = await resolveImageCorrection(ctx.db, hash);
    expect(current).toHaveProperty("sources.length", 1);
  });

  it("preserves agreeing roots and exposes conflicting identical-content decisions without choosing the newest", async () => {
    await correct("first", "Synthetic apples");
    await correct("same", "Synthetic apples");
    const agreeing = await resolveImageCorrection(ctx.db, hash);
    expect(agreeing).toMatchObject({
      kind: "confirmed",
      description: "Synthetic apples",
    });
    expect(agreeing).toHaveProperty("sources.length", 2);
    await correct("different", "Synthetic pears");
    const conflict = await resolveImageCorrection(ctx.db, hash);
    expect(conflict.kind).toBe("conflict");
    expect(conflict).toHaveProperty("sources.length", 3);
    expect(await resolveImageCorrection(ctx.db, "c".repeat(64))).toEqual({
      kind: "none",
    });
  });
  it.each([false, true])(
    "invalidates a consequence's older snapshot when member history commits (hash-less publication: %s)",
    async (hashless) => {
      const target = await question(
        "protected-history",
        undefined,
        hashless ? null : hash,
      );
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let attempts = 0;
      const consequence = withSnapshotWriteDatabase(
        ctx.db,
        async (db) => {
          attempts++;
          await getDb(db)
            .select({ id: assessmentState.id })
            .from(assessmentState)
            .where(eq(assessmentState.id, target.prediction.id));
          if (attempts === 1) {
            started.resolve();
            await release.promise;
          }
          await lockImageCorrectionContent(db, hash);
          await lockImageCorrectionRecord(db, target.picture.id);
          return getDb(db)
            .select({ operationId: feedback.operationId })
            .from(feedback)
            .where(eq(feedback.assessmentId, target.prediction.id));
        },
        { isolationLevel: "serializable" },
      );
      await started.promise;
      try {
        await reviewAssessment(ctx.db, kernelCtx(ctx), {
          assessmentId: target.prediction.id,
          operationId: "synthetic:protected-history",
          verdict: "wrong",
          intent: "history",
        });
      } finally {
        release.resolve();
      }
      expect(await consequence).toContainEqual({
        operationId: "synthetic:protected-history",
      });
      expect(attempts).toBeGreaterThan(1);
    },
  );
});
