import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { withAiInputs } from "~/server/ai/evaluation-inputs";
import {
  assessment,
  expense as expenseTable,
  assessmentState as suggestionTable,
  vendor as vendorTable,
} from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import { inferFieldAssessments } from "~/server/operations/ai.server";
import { publishAssessment } from "~/server/repo/assessment";
import {
  reviewAssessment,
  reviewAssessmentBatch,
} from "~/server/repo/assessment-review";
import { getDb } from "~/server/repo/database-helpers";
import { loadFinanceSuggestionContext } from "~/server/repo/finance-suggestion-context";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  acceptSuggestion,
  listSuggestions,
  applyFieldCorrection,
  suggestionCounts,
} from "~/server/repo/suggestion-review";
import { loadVendorSuggestionContext } from "~/server/repo/vendor-suggestion-context";

import { aiCallRunInput, ensureRun } from "./ensure-run";
import {
  PAIRED_MODEL,
  PRIMARY_MODEL,
  SUGGESTED_CATEGORY,
  categoryPorts,
  expenseFixture,
  kernelCtx,
  productCategoryId,
  productFixture,
  recordId,
  runCode,
  runSuggestions,
  startSuggestionSweep,
  suggestion,
  suggestionStatus,
} from "./suggestion-sweep.fixtures";

// Regression modes: review writes go through the entity kernel and supersede
// sibling Suggestions; rejection records a Miss and never applies the
// suggested value; stale finance evidence is refused; paired rows stay out of
// the review queue.
describe("Suggestion review", () => {
  const ctx = withTestDb();

  const sweepCategories = async (productIds: string[]) =>
    (
      await startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          fields: ["categoryId"],
          filters: { ids: productIds },
        },
        { context: kernelCtx(ctx), ...categoryPorts() },
      )
    ).id;

  it("keeps live inference out of the queue and allows a concurrent sweep publication", async () => {
    const record = await productFixture(ctx, "Synthetic live inference", {
      categoryId: taxonomyId("tools"),
    });
    const inference = await inferFieldAssessments(
      kernelCtx(ctx),
      {
        entity: "product",
        entityId: record.id,
        basisMode: "provided",
        basis: {
          name: "Synthetic live inference",
          categoryId: taxonomyShortcode("tools"),
        },
        targets: ["categoryId"],
      },
      categoryPorts(0.8).suggestPorts,
    );
    expect(inference.suggestions.categoryId?.assessmentId).toBeDefined();
    expect(
      await listSuggestions(ctx.db, {
        entity: "product",
        recordIds: [record.id],
        minConfidence: 0,
      }),
    ).toEqual([]);
    const runId = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [record.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.8) },
    );
    expect(
      await listSuggestions(ctx.db, {
        runId: await runCode(ctx.db, runId.id),
        minConfidence: 0,
      }),
    ).toHaveLength(1);
  });
  it("does not repropose reviewed wrong live inference across requesting Runs", async () => {
    const record = await productFixture(ctx, "Synthetic live wrong", {
      categoryId: taxonomyId("tools"),
    });
    const input = {
      entity: "product" as const,
      entityId: record.id,
      basisMode: "provided" as const,
      basis: {
        name: "Synthetic live wrong",
        categoryId: taxonomyShortcode("tools"),
      },
      targets: ["categoryId"],
    };
    const first = await inferFieldAssessments(
      kernelCtx(ctx),
      { ...input, runKey: crypto.randomUUID() },
      { ...categoryPorts(0.8).suggestPorts, decisionModel: PRIMARY_MODEL },
    );
    const id = first.suggestions.categoryId?.assessmentId;
    if (!id) throw new Error("Synthetic live assessment missing");
    const repeat = await inferFieldAssessments(
      kernelCtx(ctx),
      { ...input, runKey: crypto.randomUUID() },
      { ...categoryPorts(0.8).suggestPorts, decisionModel: PRIMARY_MODEL },
    );
    expect(repeat.suggestions.categoryId?.assessmentId).toBe(id);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: id,
      operationId: "synthetic:live-wrong",
      verdict: "wrong",
      intent: "history",
    });
    const replay = await inferFieldAssessments(
      kernelCtx(ctx),
      { ...input, runKey: crypto.randomUUID() },
      { ...categoryPorts(0.8).suggestPorts, decisionModel: PRIMARY_MODEL },
    );
    expect(replay.suggestions.categoryId).toBeNull();
    await executeEntity(kernelCtx(ctx), {
      action: "update",
      entity: "product",
      id: record.id,
      data: { name: "Synthetic revised live evidence" },
    });
    const revised = await inferFieldAssessments(
      kernelCtx(ctx),
      {
        ...input,
        runKey: crypto.randomUUID(),
        basis: { ...input.basis, name: "Synthetic revised live evidence" },
      },
      { ...categoryPorts(0.8).suggestPorts, decisionModel: PRIMARY_MODEL },
    );
    expect(revised.suggestions.categoryId?.assessmentId).toBeDefined();
    expect(revised.suggestions.categoryId?.assessmentId).not.toBe(id);
  });
  it.each([false, true])(
    "keeps identical served decision evidence wrong across live and stored inference, different candidate=%s",
    async (differentCandidate) => {
      const record = await productFixture(ctx, "Synthetic cross-path wrong", {
        categoryId: taxonomyId("tools"),
      });
      const listed = await executeEntity(kernelCtx(ctx), {
        action: "list",
        entity: "product",
        filters: { ids: [record.id] },
      });
      if (listed.action !== "list" || !listed.items[0])
        throw new Error("Synthetic field basis missing");
      const basis = Object.fromEntries(
        Object.entries(listed.items[0]).flatMap(([key, value]) =>
          typeof value === "string" || value === null ? [[key, value]] : [],
        ),
      );
      const basePorts = categoryPorts(0.8).suggestPorts;
      let chooseOther = false;
      const ports = {
        ...basePorts,
        registry: {
          "product.categoryId": {
            ...basePorts.registry["product.categoryId"],
            roster: async () => [
              { id: taxonomyShortcode("food"), title: "Synthetic food" },
              { id: taxonomyShortcode("books"), title: "Synthetic books" },
            ],
          },
        },
        decisionPort: async (
          request: Parameters<typeof basePorts.decisionPort>[0],
        ) => {
          const result = await basePorts.decisionPort(request);
          const keys = Object.keys(request.questions.selection.criteria);
          const choice = keys[chooseOther ? 1 : 0]!;
          return {
            ...result,
            answers: {
              selection: {
                type: "choice" as const,
                choice,
                confidence: 0.8,
                probabilities: Object.fromEntries(
                  keys.map((key) => [key, key === choice ? 0.8 : 0.1]),
                ),
              },
            },
          };
        },
      };
      const live = await withAiInputs(false, () =>
        inferFieldAssessments(
          kernelCtx(ctx),
          {
            entity: "product",
            entityId: record.id,
            basisMode: "suggested",
            basis,
            targets: ["categoryId"],
          },
          { ...ports, decisionModel: PRIMARY_MODEL },
        ),
      );
      const id = live.result.suggestions.categoryId?.assessmentId;
      if (!id) throw new Error("Synthetic live assessment missing");
      const [livePrediction] = await getDb(ctx.db)
        .select()
        .from(assessment)
        .where(eq(assessment.id, id));
      const [liveState] = await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(eq(suggestionTable.id, id));
      if (!livePrediction || !liveState)
        throw new Error("Synthetic live history missing");
      const siblingId = crypto.randomUUID();
      await getDb(ctx.db)
        .insert(assessment)
        .values({
          ...livePrediction,
          id: siblingId,
          publicationKey: `synthetic-sibling:${siblingId}`,
        });
      await getDb(ctx.db)
        .insert(suggestionTable)
        .values({
          ...liveState,
          id: siblingId,
          active: true,
          status: "pending",
        });
      const reviewed = await reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: id,
        operationId: "synthetic-cross-path-wrong",
        verdict: "wrong",
        intent: "history",
      });
      const [sibling] = await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(eq(suggestionTable.id, siblingId));
      expect(sibling).toMatchObject({
        status: "rejected",
        data: { governingFeedbackId: reviewed.feedbackId },
      });
      chooseOther = differentCandidate;
      const changed = await inferFieldAssessments(
        kernelCtx(ctx),
        {
          entity: "product",
          entityId: record.id,
          basisMode: "suggested",
          basis,
          targets: ["categoryId"],
        },
        { ...ports, decisionModel: PRIMARY_MODEL },
      );
      expect(changed.suggestions.categoryId === null).toBe(!differentCandidate);
      expect(changed.suggestions.categoryId?.value).toBe(
        differentCandidate ? taxonomyShortcode("books") : undefined,
      );
      expect(changed.suggestions.categoryId?.assessmentId).not.toBe(id);
      const stored = await withAiInputs(false, () =>
        startSuggestionSweep(
          ctx.db,
          {
            entity: "product",
            fields: ["categoryId"],
            filters: { ids: [record.id] },
          },
          {
            context: kernelCtx(ctx),
            suggestPorts: ports,
            samplePair: () => false,
          },
        ),
      );
      expect(stored.inputs).toEqual(live.inputs);
      expect(
        (
          await listSuggestions(ctx.db, {
            entity: "product",
            recordIds: [record.id],
            minConfidence: 0,
          })
        ).map((row) => row.suggestedValue),
      ).toEqual(differentCandidate ? [taxonomyShortcode("books")] : []);
    },
  );
  it("does not repropose a wrong field for unchanged evidence and policy, but permits a genuine evidence revision", async () => {
    const record = await productFixture(ctx, "Synthetic unchanged field", {
      categoryId: taxonomyId("tools"),
    });
    const start = () =>
      startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          fields: ["categoryId"],
          filters: { ids: [record.id] },
        },
        { context: kernelCtx(ctx), ...categoryPorts(0.8) },
      );
    const first = await start();
    const [row] = await listSuggestions(ctx.db, {
      runId: await runCode(ctx.db, first.id),
      minConfidence: 0,
    });
    if (!row) throw new Error("Synthetic field assessment missing");
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: row.id,
      operationId: "synthetic:wrong-field",
      verdict: "wrong",
      intent: "history",
    });
    await start();
    expect(
      await listSuggestions(ctx.db, {
        entity: "product",
        recordIds: [record.id],
        minConfidence: 0,
      }),
    ).toEqual([]);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(suggestionTable)
          .where(eq(suggestionTable.id, row.id))
      )[0]?.suppression,
    ).toBeNull();
    await executeEntity(kernelCtx(ctx), {
      action: "update",
      entity: "product",
      id: record.id,
      data: { name: "Synthetic revised field evidence" },
    });
    await start();
    expect(
      await listSuggestions(ctx.db, {
        entity: "product",
        recordIds: [record.id],
        minConfidence: 0,
      }),
    ).toHaveLength(1);
  });

  it("accepts a persisted Suggestion through the entity kernel, applies its value and supersedes siblings", async () => {
    const context = kernelCtx(ctx);
    const product = await productFixture(ctx, "Synthetic accepted item", {
      categoryId: taxonomyId("tools"),
    });
    const runId = await sweepCategories([product.id]);
    const [row] = await listSuggestions(ctx.db, {
      runId: await runCode(ctx.db, runId),
      minConfidence: 0,
    });
    if (!row) throw new Error("Synthetic Suggestion was not persisted");
    expect(row.suggestedValue).toBe(taxonomyShortcode(SUGGESTED_CATEGORY));
    expect(
      await listSuggestions(ctx.db, {
        minConfidence: 0,
        entity: "product",
        recordIds: [product.id],
        fields: ["categoryId"],
      }),
    ).toEqual([
      expect.objectContaining({
        id: row.id,
        model: PRIMARY_MODEL,
        recordId: product.id,
      }),
    ]);
    const [sibling] = await getDb(ctx.db)
      .insert(suggestionTable)
      .values({
        runId,
        entity: "product",
        recordId: await recordId(ctx.db, product.id, "product"),
        field: "categoryId",
        currentValue: taxonomyShortcode("tools"),
        suggestedValue: taxonomyShortcode("household"),
        confidence: 0.75,
        model: PRIMARY_MODEL,
        kind: "correction",
        status: "pending",
      })
      .returning({ id: suggestionTable.id });

    await acceptSuggestion(ctx.db, context, { id: row.id });
    expect(await suggestionStatus(ctx.db, row.id)).toBe("applied");
    expect(await suggestionStatus(ctx.db, sibling!.id)).toBe("superseded");
    expect(await productCategoryId(ctx.db, product.id)).toBe(
      taxonomyId(SUGGESTED_CATEGORY),
    );
    expect(
      await listSuggestions(ctx.db, {
        minConfidence: 0,
        entity: "product",
        recordIds: [product.id],
        fields: ["categoryId"],
      }),
    ).toHaveLength(0);
  });

  // A list page reads with a limit; unserved trial candidates were dropped only
  // after it, so enough of them hid the record's reviewable Suggestion.
  it("limits only reviewable rows, never unserved trial candidates", async () => {
    const product = await productFixture(ctx, "Synthetic limited item", {
      categoryId: taxonomyId("tools"),
    });
    const runId = await sweepCategories([product.id]);
    const pairKey = crypto.randomUUID();
    const uuid = await recordId(ctx.db, product.id, "product");
    await getDb(ctx.db)
      .insert(suggestionTable)
      .values(
        [0.99, 0.98, 0.97].map((confidence) => ({
          runId,
          entity: "product" as const,
          recordId: uuid,
          field: "categoryId",
          currentValue: taxonomyShortcode("tools"),
          suggestedValue: taxonomyShortcode("household"),
          confidence,
          model: "synthetic/unserved-trial",
          kind: "correction" as const,
          status: "pending" as const,
          pairKey,
        })),
      );
    const page = await listSuggestions(ctx.db, {
      entity: "product",
      recordIds: [product.id],
      fields: ["categoryId"],
      minConfidence: 0,
      limit: 1,
    });
    expect(page).toEqual([expect.objectContaining({ model: PRIMARY_MODEL })]);
  });

  it("records a plain rejection as a Miss and applies a reviewer-corrected value", async () => {
    const context = kernelCtx(ctx);
    const dismissed = await productFixture(ctx, "Synthetic dismissed item", {
      categoryId: taxonomyId("tools"),
    });
    const corrected = await productFixture(ctx, "Synthetic corrected item", {
      categoryId: taxonomyId("tools"),
    });
    const runId = await sweepCategories([dismissed.id, corrected.id]);
    const pending = await listSuggestions(ctx.db, {
      runId: await runCode(ctx.db, runId),
      minConfidence: 0,
    });
    expect(pending).toHaveLength(2);
    const pendingFor = (id: string) => {
      const row = pending.find((candidate) => candidate.recordId === id);
      if (!row) throw new Error(`Synthetic Suggestion missing for ${id}`);
      return row;
    };
    const dismissedRow = pendingFor(dismissed.id);
    const correctedRow = pendingFor(corrected.id);
    expect(dismissedRow.kind).toBe("correction");

    await reviewAssessment(ctx.db, context, {
      assessmentId: dismissedRow.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "history",
    });
    await applyFieldCorrection(ctx.db, context, {
      id: correctedRow.id,
      correctValue: taxonomyShortcode("household"),
    });

    const saved = await runSuggestions(ctx.db, runId);
    expect(saved.find(({ id }) => id === dismissedRow.id)).toMatchObject({
      status: "rejected",
      suggestedValue: taxonomyShortcode(SUGGESTED_CATEGORY),
      correctValue: null,
    });
    expect(saved.find(({ id }) => id === correctedRow.id)).toMatchObject({
      status: "rejected",
      suggestedValue: taxonomyShortcode(SUGGESTED_CATEGORY),
      correctValue: taxonomyShortcode("household"),
    });
    expect(await productCategoryId(ctx.db, dismissed.id)).toBe(
      taxonomyId("tools"),
    );
    expect(await productCategoryId(ctx.db, corrected.id)).toBe(
      taxonomyId("household"),
    );
    expect(
      await listSuggestions(ctx.db, {
        runId: await runCode(ctx.db, runId),
        minConfidence: 0,
      }),
    ).toHaveLength(0);
    // Reviewed history is the decision-eval label set read over MCP.
    const history = await listSuggestions(ctx.db, {
      runId: await runCode(ctx.db, runId),
      minConfidence: 0,
      status: "rejected",
    });
    expect(history.map(({ correctValue }) => correctValue).sort()).toEqual(
      [null, taxonomyShortcode("household")].sort(),
    );
    // A record-scoped history read keeps its status; it once fell through to
    // a pending-only page read and returned no labels.
    expect(
      await listSuggestions(ctx.db, {
        entity: "product",
        recordIds: [dismissed.id, corrected.id],
        fields: ["categoryId"],
        status: "rejected",
        minConfidence: 0,
      }),
    ).toHaveLength(2);
    await expect(
      listSuggestions(ctx.db, { recordIds: [dismissed.id] }),
    ).rejects.toThrow(/name its entity/);
    expect(
      await listSuggestions(ctx.db, {
        minConfidence: 0,
        entity: "product",
        recordIds: [dismissed.id, corrected.id],
        fields: ["categoryId"],
      }),
    ).toHaveLength(0);
  });

  it("settles batch accept and reject per id, reporting a settled id's failure without rolling back the rest", async () => {
    const context = kernelCtx(ctx);
    const accepted = await productFixture(ctx, "Synthetic batch accepted", {
      categoryId: taxonomyId("tools"),
    });
    const rejected = await productFixture(ctx, "Synthetic batch rejected", {
      categoryId: taxonomyId("tools"),
    });
    const runId = await sweepCategories([accepted.id, rejected.id]);
    const code = await runCode(ctx.db, runId);
    const pending = await listSuggestions(ctx.db, {
      runId: code,
      minConfidence: 0,
    });
    const idFor = (recordId: string) =>
      pending.find((row) => row.recordId === recordId)?.id ?? "";
    const accept = await reviewAssessmentBatch(ctx.db, context, {
      items: [
        {
          assessmentId: idFor(accepted.id),
          operationId: crypto.randomUUID(),
          verdict: "correct",
          intent: "apply",
        },
      ],
    });
    expect(accept).toEqual([
      expect.objectContaining({
        assessmentId: idFor(accepted.id),
        ok: true,
        status: "applied",
        applied: true,
      }),
    ]);
    // The already-applied id fails on its own; the pending one still rejects.
    const reject = await reviewAssessmentBatch(ctx.db, context, {
      items: [
        {
          assessmentId: idFor(accepted.id),
          operationId: crypto.randomUUID(),
          verdict: "correct",
          intent: "apply",
          expectedFingerprint: "synthetic-stale-fingerprint",
        },
        {
          assessmentId: idFor(rejected.id),
          operationId: crypto.randomUUID(),
          verdict: "wrong",
          intent: "history",
        },
      ],
    });
    expect(reject).toEqual([
      expect.objectContaining({ assessmentId: idFor(accepted.id), ok: false }),
      expect.objectContaining({
        assessmentId: idFor(rejected.id),
        ok: true,
        status: "rejected",
        applied: false,
      }),
    ]);
    expect(await productCategoryId(ctx.db, accepted.id)).toBe(
      taxonomyId(SUGGESTED_CATEGORY),
    );
    expect(await productCategoryId(ctx.db, rejected.id)).toBe(
      taxonomyId("tools"),
    );
    expect(await suggestionCounts(ctx.db, { runId: code })).toEqual([
      expect.objectContaining({
        entity: "product",
        field: "categoryId",
        pending: 0,
        applied: 1,
        rejected: 1,
      }),
    ]);
  });

  it("records a per-record wrong verdict as a Miss on its ai_suggest Run", async () => {
    const context = kernelCtx(ctx);
    const product = await productFixture(ctx, "Synthetic dismissed item", {
      categoryId: taxonomyId("tools"),
    });
    const runId = await ensureRun(
      ctx.db,
      context.actorContext,
      aiCallRunInput(context.actorContext, { runKey: crypto.randomUUID() }),
    );
    const prediction = await publishAssessment(
      ctx.db,
      {
        publicationKey: "synthetic:live-field-miss",
        family: "field",
        subject: {
          kind: "field",
          entity: "product",
          recordId: await recordId(ctx.db, product.id, "product"),
          field: "categoryId",
        },
        judgment: { value: taxonomyShortcode("food") },
        fingerprint: null,
        producer: null,
        evidence: null,
      },
      {
        runId,
        model: "unknown",
        currentValue: taxonomyShortcode("tools"),
        suggestedValue: taxonomyShortcode("food"),
        confidence: 0.91,
        kind: "correction",
      },
    );
    await reviewAssessment(ctx.db, context, {
      assessmentId: prediction.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "history",
    });
    expect(await runSuggestions(ctx.db, runId)).toEqual([
      expect.objectContaining({
        runId,
        entity: "product",
        field: "categoryId",
        status: "rejected",
        suggestedValue: taxonomyShortcode("food"),
      }),
    ]);
  });

  it("refuses accepting a finance suggestion after its inference evidence changes", async () => {
    const context = kernelCtx(ctx);
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic review category",
    });
    const line = await expenseFixture(ctx.db, "Synthetic reviewed expense");
    const suggest = vi.fn(async () => {
      const review = await loadFinanceSuggestionContext(
        ctx.db,
        "expense",
        line.shortcode,
      );
      return suggestion("spendingCategoryId", {
        value: category.shortcode,
        label: category.name,
        probability: 0.7,
        financeReview: {
          entity: "expense",
          entityId: line.shortcode,
          field: "spendingCategoryId",
          fingerprint: review.fingerprint,
        },
      });
    });
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "expense",
        fields: ["spendingCategoryId"],
        filters: { ids: [line.shortcode] },
      },
      { context, suggest },
    );
    const [row] = await listSuggestions(ctx.db, {
      runId: await runCode(ctx.db, started.id),
      minConfidence: 0,
    });
    if (!row) throw new Error("Synthetic finance suggestion was not persisted");
    await getDb(ctx.db)
      .update(expenseTable)
      .set({ cost: 13 })
      .where(eq(expenseTable.id, line.id));
    await expect(
      acceptSuggestion(ctx.db, context, { id: row.id }),
    ).rejects.toThrow(/changed|fresh suggestion/i);
    expect(await suggestionStatus(ctx.db, row.id)).toBe("pending");
    const [saved] = await getDb(ctx.db)
      .select({ spendingCategoryId: expenseTable.spendingCategoryId })
      .from(expenseTable)
      .where(eq(expenseTable.id, line.id));
    expect(saved?.spendingCategoryId).toBeNull();
  });

  it("applies a Vendor default category with Expense history on auto-apply and on accept", async () => {
    const context = kernelCtx(ctx);
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic vendor category",
    });
    const vendorWithHistory = async (name: string) => {
      const vendor = await insertWithShortcode(ctx.db, "vendor", { name });
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-09-01",
      });
      await expenseFixture(ctx.db, `${name} expense`, {
        purchaseId: purchase.id,
      });
      return vendor;
    };
    const autoVendor = await vendorWithHistory("Synthetic auto vendor");
    const reviewedVendor = await vendorWithHistory("Synthetic reviewed vendor");
    const vendors = [autoVendor, reviewedVendor];
    const suggest = vi.fn(async (_db, _runId, input) => {
      const review = await loadVendorSuggestionContext(ctx.db, input.entityId!);
      return suggestion("defaultSpendingCategoryId", {
        value: category.shortcode,
        label: category.name,
        // Auto-apply above the threshold; queue the other for review.
        probability: input.entityId === autoVendor.shortcode ? 0.95 : 0.7,
        financeReview: {
          entity: "vendor",
          entityId: input.entityId!,
          field: "defaultSpendingCategoryId",
          fingerprint: review.fingerprint,
        },
      });
    });
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "vendor",
        fields: ["defaultSpendingCategoryId"],
        filters: { ids: vendors.map(({ shortcode }) => shortcode) },
      },
      { context, suggest },
    );
    const vendorCategory = async (id: (typeof vendors)[number]["id"]) => {
      const [saved] = await getDb(ctx.db)
        .select({
          defaultSpendingCategoryId: vendorTable.defaultSpendingCategoryId,
        })
        .from(vendorTable)
        .where(eq(vendorTable.id, id));
      return saved?.defaultSpendingCategoryId;
    };
    expect(await vendorCategory(autoVendor.id)).toBe(category.id);
    expect(await vendorCategory(reviewedVendor.id)).toBeNull();

    const pending = await listSuggestions(ctx.db, {
      runId: await runCode(ctx.db, started.id),
      minConfidence: 0,
    });
    expect(pending).toEqual([
      expect.objectContaining({ recordId: reviewedVendor.shortcode }),
    ]);
    await acceptSuggestion(ctx.db, context, { id: pending[0]!.id });
    expect(await vendorCategory(reviewedVendor.id)).toBe(category.id);
    expect(
      (await runSuggestions(ctx.db, started.id)).map(({ status }) => status),
    ).toEqual(["applied", "applied"]);
  });

  it("filters pending pinned suggestions by kind and clears after a generic update", async () => {
    const context = kernelCtx(ctx);
    const addition = await productFixture(ctx, "Synthetic suggestion addition");
    const correction = await productFixture(
      ctx,
      "Synthetic suggestion correction",
      { categoryId: taxonomyId("tools") },
    );
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [addition.id, correction.id] },
      },
      { context, samplePair: () => true, ...categoryPorts(0.6) },
    );
    const list = async (kind: "any" | "addition" | "correction") => {
      const result = await executeEntity(context, {
        action: "list",
        entity: "product",
        filters: { suggestionPresenceFilter: kind },
        pagination: { pageIndex: 0, pageSize: 100 },
      });
      if (result.action !== "list") throw new Error("Expected list result");
      return result.items.map((row) => row.id);
    };
    expect(await list("any")).toEqual(
      expect.arrayContaining([addition.id, correction.id]),
    );
    expect(await list("addition")).toContain(addition.id);
    expect(await list("addition")).not.toContain(correction.id);
    expect(await list("correction")).toContain(correction.id);
    expect(await list("correction")).not.toContain(addition.id);

    const additionRecordId = await recordId(ctx.db, addition.id, "product");
    const additionRow = async (model: string) => {
      const [row] = await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(
          and(
            eq(suggestionTable.runId, started.id),
            eq(suggestionTable.recordId, additionRecordId),
            eq(suggestionTable.model, model),
          ),
        );
      if (!row) throw new Error(`Synthetic ${model} Suggestion is missing`);
      return row;
    };
    // The low-confidence paired row stays pending but never surfaces once
    // the pinned row leaves the pending set.
    expect((await additionRow(PAIRED_MODEL)).status).toBe("pending");
    const pinned = await additionRow(PRIMARY_MODEL);
    await getDb(ctx.db)
      .update(suggestionTable)
      .set({ status: "superseded" })
      .where(eq(suggestionTable.id, pinned.id));
    expect(await list("any")).not.toContain(addition.id);
    await executeEntity(context, {
      action: "update",
      entity: "product",
      id: parseShortcodeFor("product", addition.id),
      data: { categoryId: taxonomyShortcode("tools") },
    });
    expect(await list("any")).not.toContain(addition.id);
  });
});
