import { and, eq, inArray } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { assessmentState, feedback, job, auditLog } from "~/server/db/schema";
import {
  kernelCtx,
  productFixture,
  productCategoryId,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntityAs } from "~/server/entity-kernel";
import { publishFieldAssessment } from "~/server/generic/assessment/repo/assessment";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { listAutomaticDecisions } from "~/server/generic/assessment/repo/automatic-decisions";
import { applyAutomaticRules } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import {
  readConfirmedCorrection,
  readFieldCorrectionSources,
} from "~/server/generic/assessment/repo/correction-sources";
import { fieldInputFingerprint } from "~/server/generic/assessment/repo/field-input-fence";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";
import { correctionPropagationHandler } from "~/server/generic/assessment/service/correction-propagation";
import { advanceJob } from "~/server/generic/jobs/service/jobs";

describe("confirmed correction propagation", () => {
  const ctx = withTestDb();
  const key = "synthetic-complete-decision-inputs";

  async function propose(
    options: { automatic?: boolean; correctionKey?: string } = {},
  ) {
    const product = await productFixture(ctx, "Synthetic classification item");
    const manifest = await producingAiManifest(ctx.db);
    const prediction = await publishFieldAssessment(
      ctx.db,
      {
        entity: "product",
        recordId: product.entityId,
        field: "categoryId",
        currentValue: null,
        suggestedValue: taxonomyShortcode("tools"),
        kind: "addition",
        confidence: options.automatic ? 0.99 : 0.88,
        model: "typesafe/jev",
        provenance: {
          dependencies: dependencyStamps(
            manifest,
            fieldDependencyKeys("product", "categoryId"),
          ),
          inputFingerprint: "synthetic-model-input",
          optionFingerprint: "synthetic-options",
          model: "typesafe/jev",
        },
        data: {
          correctionKey: options.correctionKey ?? key,
          liveInputFingerprint: await fieldInputFingerprint(
            ctx.db,
            "product",
            product.entityId,
            "categoryId",
          ),
        },
      },
      true,
    );
    const applied = options.automatic
      ? await applyAutomaticRules(ctx.db, [prediction.id])
      : null;
    expect(applied?.applied ?? []).toEqual(
      options.automatic ? [prediction.id] : [],
    );
    return { product, prediction };
  }

  async function correct(value: string | null = taxonomyShortcode("food")) {
    const source = await propose();
    const result = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: source.prediction.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      correction: { present: true, value },
      intent: "apply",
    });
    expect(
      await readConfirmedCorrection(ctx.db, result.feedbackId),
    ).not.toBeNull();
    return { ...source, result };
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
    throw new Error(
      "Synthetic correction work failed to finish its bounded pages",
    );
  }

  it("repairs an untouched automatic assignment and an equivalent future weak proposal, once", async () => {
    const historical = await propose({ automatic: true });
    const original = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, historical.prediction.id));
    const source = await correct();
    await drain();
    expect(await productCategoryId(ctx.db, historical.product.id)).toBe(
      taxonomyId("food"),
    );
    const future = await propose();
    await drain();
    expect(await productCategoryId(ctx.db, future.product.id)).toBe(
      taxonomyId("food"),
    );
    const history = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, historical.prediction.id));
    expect(history).toEqual(expect.arrayContaining(original));
    expect(
      history.filter(
        (row) =>
          row.operationId ===
          `correction:${source.result.feedbackId}:${historical.prediction.id}`,
      ),
    ).toHaveLength(1);
    await drain();
    expect(
      await getDb(ctx.db)
        .select()
        .from(feedback)
        .where(eq(feedback.assessmentId, historical.prediction.id)),
    ).toEqual(history);
    const [state] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, historical.prediction.id));
    expect(state?.suggestedValue).toBe(taxonomyShortcode("tools"));
    expect(state?.acceptanceReceipt).toMatchObject({ mode: "automatic" });
    const audit = await listAutomaticDecisions(ctx.db, {
      recordIds: [future.product.id],
    });
    expect(audit.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          automaticRule: "member-correction@1",
          summary: `Automatically corrected to ${JSON.stringify(taxonomyShortcode("food"))}`,
        }),
      ]),
    );
  });

  it("preserves intervening member edits and nonequivalent decision inputs", async () => {
    const edited = await propose({ automatic: true });
    const different = await propose({
      correctionKey: "synthetic-other-inputs",
    });
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: edited.product.id,
      data: { categoryId: taxonomyShortcode("books") },
    });
    await correct();
    await drain();
    expect(await productCategoryId(ctx.db, edited.product.id)).toBe(
      taxonomyId("books"),
    );
    expect(await productCategoryId(ctx.db, different.product.id)).toBeNull();
  });

  it("does not grant authority to history grades or refused applications", async () => {
    const source = await propose();
    const grade = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: source.prediction.id,
      operationId: "synthetic-grade",
      verdict: "wrong",
      intent: "history",
      correction: { present: true, value: null },
    });
    expect(await readConfirmedCorrection(ctx.db, grade.feedbackId)).toBeNull();
    const failed = await propose();
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: failed.prediction.id,
        operationId: "synthetic-refused",
        verdict: "wrong",
        intent: "apply",
        correction: { present: true, value: "not-a-category" },
      }),
    ).rejects.toThrow(/category|shortcode|identifier|Invalid/i);
    const rows = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.operationId, "synthetic-refused"));
    expect(rows).toHaveLength(1);
    expect(await readConfirmedCorrection(ctx.db, rows[0]!.id)).toBeNull();
  });

  it("holds conflicting confirmed corrections instead of choosing the latest one", async () => {
    await correct(taxonomyShortcode("food"));
    await correct(taxonomyShortcode("books"));
    const target = await propose();
    await drain();
    expect(await productCategoryId(ctx.db, target.product.id)).toBeNull();
    const receipts = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, target.prediction.id));
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          receipt: {
            status: "held",
            reason: "Equivalent evidence has conflicting member corrections",
          },
        }),
      ]),
    );
    const queue = await listSuggestionPage(ctx.db, {
      family: "field",
      recordIds: [target.product.id],
    });
    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: expect.arrayContaining([
            expect.objectContaining({
              kind: "text",
              text: expect.stringContaining("conflicting member corrections"),
            }),
          ]),
        }),
      ]),
    );
  });

  it("propagates an explicit null without manufacturing a model confidence", async () => {
    const historical = await propose({ automatic: true });
    await correct(null);
    await drain();
    expect(await productCategoryId(ctx.db, historical.product.id)).toBeNull();
    const [state] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, historical.prediction.id));
    expect(state?.confidence).toBe(0.99);
    expect(state?.suggestedValue).toBe(taxonomyShortcode("tools"));
  });

  it("retires a future non-null proposal when the correction is explicit null", async () => {
    await correct(null);
    const future = await propose();
    await drain();
    expect(await productCategoryId(ctx.db, future.product.id)).toBeNull();
    const [state] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, future.prediction.id));
    expect(state).toMatchObject({ status: "superseded", active: false });
  });

  it("enrolls a publication committed after the correction history scan", async () => {
    let release = () => {};
    let published = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepared = new Promise<void>((resolve) => {
      published = resolve;
    });
    const target = await propose({ correctionKey: "other-inputs" });
    const publication = withTransactionDatabase(ctx.db, async (db) => {
      const manifest = await producingAiManifest(db);
      await publishFieldAssessment(
        db,
        {
          entity: "product",
          recordId: target.product.entityId,
          field: "categoryId",
          currentValue: null,
          suggestedValue: taxonomyShortcode("tools"),
          kind: "addition",
          confidence: 0.88,
          model: "typesafe/jev",
          provenance: {
            dependencies: dependencyStamps(
              manifest,
              fieldDependencyKeys("product", "categoryId"),
            ),
            inputFingerprint: "synthetic-model-input",
            optionFingerprint: "synthetic-options",
            model: "typesafe/jev",
          },
          data: {
            correctionKey: key,
            liveInputFingerprint: await fieldInputFingerprint(
              db,
              "product",
              target.product.entityId,
              "categoryId",
            ),
          },
        },
        true,
      );
      published();
      await barrier;
    });
    await prepared;
    try {
      await correct();
      await drain();
    } finally {
      release();
    }
    await publication;
    await drain();
    expect(await productCategoryId(ctx.db, target.product.id)).toBe(
      taxonomyId("food"),
    );
  });

  it("withholds a future confident model answer when a current correction exists", async () => {
    await correct();
    const future = await propose();
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ confidence: 0.99 })
      .where(eq(assessmentState.id, future.prediction.id));
    expect(
      (await applyAutomaticRules(ctx.db, [future.prediction.id])).applied,
    ).toEqual([]);
    expect(await productCategoryId(ctx.db, future.product.id)).toBeNull();
    await drain();
    expect(await productCategoryId(ctx.db, future.product.id)).toBe(
      taxonomyId("food"),
    );
  });

  it("uses one canonical correction when a member saves over an automatic assignment", async () => {
    const historical = await propose({ automatic: true });
    const source = await propose({ automatic: true });
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: source.product.id,
      data: { categoryId: taxonomyShortcode("food") },
    });
    const result = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: source.prediction.id,
      operationId: "synthetic-saved-correction",
      verdict: "wrong",
      intent: "apply",
      correction: { present: true, value: taxonomyShortcode("food") },
      application: { kind: "saved_field", recordId: source.product.id },
    });
    const roots = await readFieldCorrectionSources(ctx.db, key);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.feedbackId).toBe(result.feedbackId);
    expect(roots[0]?.applicationReceipt).toMatchObject({
      reason: "member_correction",
      mode: "member",
    });
    await drain();
    expect(await productCategoryId(ctx.db, historical.product.id)).toBe(
      taxonomyId("food"),
    );
  });

  it("holds a restored source value even when later audit writes sort before its receipt", async () => {
    const target = await propose();
    const source = await correct();
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: source.product.id,
      data: { categoryId: taxonomyShortcode("books") },
    });
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: source.product.id,
      data: { categoryId: taxonomyShortcode("food") },
    });
    // Audit timestamps reflect transaction start, so a later write can sort before the correction.
    await getDb(ctx.db)
      .update(auditLog)
      .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(
        and(
          eq(auditLog.entityId, source.product.entityId),
          eq(auditLog.action, "update"),
        ),
      );
    await drain();
    expect(await productCategoryId(ctx.db, target.product.id)).toBeNull();
  });
});
