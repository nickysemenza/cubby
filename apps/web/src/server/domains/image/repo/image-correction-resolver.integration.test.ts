import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { image } from "~/server/db/schema";
import { resolveImageCorrection } from "~/server/domains/image/repo/image-correction-resolver";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

// Failure modes: a grade or stale confirmation becomes reusable authority;
// timestamps choose a winner among contradictory corrections of identical bytes.
describe("image correction authority", () => {
  const ctx = withTestDb();
  const hash = "a".repeat(64);

  async function question(
    key: string,
    existing?: Pick<typeof image.$inferSelect, "id" | "sha256">,
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
        contentHash: hash,
      },
      judgment: "Synthetic model prose",
      fingerprint: hash,
      producer: null,
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
});
