import { suggestionSweepRunProgress } from "@cubby/schemas/run-fields";
import { and, eq, sql } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  auditLog,
  expense as expenseTable,
  run as runTable,
} from "~/server/db/schema";
import { loadFinanceSuggestionContext } from "~/server/domains/financial-transaction/repo/finance-suggestion-context";
import { listSuggestions } from "~/server/generic/assessment/repo/suggestion-review";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { pauseSuggestionSweep } from "./suggestion-sweep";
import {
  PAIRED_MODEL,
  PRIMARY_MODEL,
  SUGGESTED_CATEGORY,
  categoryPorts,
  expenseFixture,
  kernelCtx,
  noProposal,
  productCategoryId,
  productFixture,
  runCode,
  resumeSuggestionSweep,
  runSuggestions,
  startSuggestionSweep,
  suggestion,
} from "./suggestion-sweep.fixtures";

const savedRun = async (
  db: Parameters<typeof getDb>[0],
  id: Parameters<typeof runSuggestions>[1],
) => {
  const [row] = await getDb(db)
    .select()
    .from(runTable)
    .where(eq(runTable.id, id));
  if (!row) throw new Error("Synthetic sweep Run is missing");
  return row;
};

// Regression modes: an Addition above threshold applies through the entity
// kernel; Corrections and low confidence remain pending; paired decisions
// share provenance and never apply; pause/resume checkpoints by unprocessed
// record and field.
describe("persisted Suggestion sweeps", () => {
  const ctx = withTestDb();

  it("atomically identifies automatic acceptance and its generating Run in the actual field audit", async () => {
    const item = await productFixture(ctx, "Synthetic audited addition");
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts() },
    );
    const [row] = await runSuggestions(ctx.db, started.id);
    expect(row?.acceptanceReceipt).toMatchObject({
      mode: "automatic",
      runId: started.id,
      reason: "confident_addition",
    });
    const audits = await getDb(ctx.db)
      .select()
      .from(auditLog)
      .where(eq(auditLog.runId, started.id));
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityKind: "product", action: "update" }),
      ]),
    );
    expect(row?.acceptanceReceipt?.auditIds).toEqual(
      audits.map((audit) => audit.id),
    );
  });

  it("checkpoints no-proposal targets by public id and field for filter-selected rows only", async () => {
    const context = kernelCtx(ctx);
    const matching = await productFixture(ctx, "Synthetic selected product");
    await productFixture(ctx, "Synthetic unselected product", {
      manufacturer: "Other maker",
    });
    const processed: Array<{ id: string; field: string }> = [];
    const suggest = vi.fn(async (_db, _runId, input) => {
      const field = input.targets[0]!;
      processed.push({ id: input.entityId!, field });
      return noProposal(field);
    });
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId", "tags"],
        filters: { manufacturerFilter: "Synthetic maker" },
      },
      { context, suggest, pauseAfter: 1 },
    );
    expect(processed).toEqual([{ id: matching.id, field: "categoryId" }]);
    const paused = await savedRun(ctx.db, started.id);
    expect(suggestionSweepRunProgress.parse(paused.progress).done).toBe(1);

    await resumeSuggestionSweep(ctx.db, started.id, { context, suggest });
    expect(processed).toEqual([
      { id: matching.id, field: "categoryId" },
      { id: matching.id, field: "tags" },
    ]);
    const finished = await savedRun(ctx.db, started.id);
    expect(finished.status).toBe("completed");
    expect(finished.progress).toMatchObject({ done: 2, total: 2, queued: 2 });

    await expect(
      resumeSuggestionSweep(ctx.db, started.id, { context, suggest }),
    ).rejects.toThrow(/completed suggestion sweep/i);
    expect(processed).toHaveLength(2);
  });

  it("pins the model, applies high-confidence Additions and resumes a paused filtered sweep with total equal to done", async () => {
    const context = kernelCtx(ctx);
    const products = await Promise.all(
      ["Alpha", "Beta", "Gamma"].map((name) =>
        productFixture(ctx, `Synthetic ${name}`),
      ),
    );
    // Applied rows leave the `none` filter, so the resumed read lists fewer
    // targets than the first; total must still count processed targets.
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { categoryPresenceFilter: "none" },
      },
      { context, pauseAfter: 2, ...categoryPorts() },
    );
    const paused = await savedRun(ctx.db, started.id);
    expect(paused.purpose).toBe("suggestion_sweep");
    expect(paused.status).toBe("paused");
    expect(paused.input).toMatchObject({
      entity: "product",
      fields: ["categoryId"],
      filters: { categoryPresenceFilter: "none" },
      decisionModel: PRIMARY_MODEL,
    });
    expect(paused.progress).toMatchObject({ done: 2, applied: 2 });

    await pauseSuggestionSweep(ctx.db, started.id);
    await resumeSuggestionSweep(ctx.db, started.id, {
      context,
      ...categoryPorts(),
    });
    const finished = await savedRun(ctx.db, started.id);
    expect(finished.status).toBe("completed");
    expect(finished.progress).toMatchObject({
      total: 3,
      done: 3,
      applied: 3,
      queued: 0,
      failed: 0,
    });
    const rows = await runSuggestions(ctx.db, started.id);
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(row).toMatchObject({
        kind: "addition",
        status: "applied",
        model: PRIMARY_MODEL,
        suggestedValue: taxonomyShortcode(SUGGESTED_CATEGORY),
      });
    for (const product of products)
      expect(await productCategoryId(ctx.db, product.id)).toBe(
        taxonomyId(SUGGESTED_CATEGORY),
      );
  });

  // A migrated paused Sweep has counts and processed IDs but no target ledger yet.
  it("prepares a legacy paused roster on resume without losing completed counts", async () => {
    const context = kernelCtx(ctx);
    const products = await Promise.all(
      ["Legacy first", "Legacy next"].map((name) =>
        productFixture(ctx, `Synthetic ${name}`),
      ),
    );
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { categoryPresenceFilter: "none" },
      },
      { context, pauseAfter: 1, ...categoryPorts() },
    );
    const processed = (
      await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(
          and(
            eq(aiEvaluation.runId, started.id),
            eq(aiEvaluation.state, "completed"),
          ),
        )
    )[0]!;
    await getDb(ctx.db)
      .delete(aiEvaluationRequest)
      .where(eq(aiEvaluationRequest.runId, started.id));
    // Existing Suggestion history retains its evaluation; make only the unprocessed target legacy.
    await getDb(ctx.db)
      .delete(aiEvaluation)
      .where(
        and(
          eq(aiEvaluation.runId, started.id),
          eq(aiEvaluation.state, "queued"),
        ),
      );
    await getDb(ctx.db)
      .update(runTable)
      .set({
        status: "paused",
        progress: sql`${JSON.stringify({ total: 2, done: 1, applied: 1, queued: 0, failed: 0, processedTargetIds: [`${processed.target.recordId}:categoryId`] })}::jsonb`,
      })
      .where(eq(runTable.id, started.id));
    await resumeSuggestionSweep(ctx.db, started.id, {
      context,
      ...categoryPorts(),
    });
    const finished = await savedRun(ctx.db, started.id);
    expect(finished.status).toBe("completed");
    expect(finished.progress).toMatchObject({ total: 2, done: 2, applied: 2 });
    for (const product of products)
      expect(await productCategoryId(ctx.db, product.id)).toBe(
        taxonomyId(SUGGESTED_CATEGORY),
      );
    expect(await runSuggestions(ctx.db, started.id)).toHaveLength(2);
  });

  it("keeps a high-confidence Correction and a low-confidence Addition pending", async () => {
    const context = kernelCtx(ctx);
    const correction = await productFixture(ctx, "Synthetic corrected item", {
      categoryId: taxonomyId("tools"),
    });
    const addition = await productFixture(ctx, "Synthetic low-confidence item");
    const sweep = (id: string, confidence: number) =>
      startSuggestionSweep(
        ctx.db,
        { entity: "product", fields: ["categoryId"], filters: { ids: [id] } },
        { context, ...categoryPorts(confidence) },
      );

    const highRun = await sweep(correction.id, 0.97);
    expect(await runSuggestions(ctx.db, highRun.id)).toEqual([
      expect.objectContaining({
        kind: "correction",
        status: "pending",
        confidence: 0.97,
      }),
    ]);
    expect(await productCategoryId(ctx.db, correction.id)).toBe(
      taxonomyId("tools"),
    );

    const lowRun = await sweep(addition.id, 0.6);
    expect(await runSuggestions(ctx.db, lowRun.id)).toEqual([
      expect.objectContaining({
        kind: "addition",
        status: "pending",
        confidence: 0.6,
      }),
    ]);
    expect(await productCategoryId(ctx.db, addition.id)).toBeNull();
  });

  it("stores a paired model row under one pair key without applying it", async () => {
    const context = kernelCtx(ctx);
    const product = await productFixture(ctx, "Synthetic paired item");
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [product.id] },
      },
      { context, samplePair: () => true, ...categoryPorts() },
    );
    const rows = await runSuggestions(ctx.db, started.id);
    expect(rows).toHaveLength(2);
    const [pairKey] = new Set(rows.map((row) => row.pairKey));
    expect(pairKey).toBeTruthy();
    expect(rows.every((row) => row.pairKey === pairKey)).toBe(true);
    expect(rows.find((row) => row.model === PRIMARY_MODEL)).toBeDefined();
    expect(rows.find((row) => row.model === PAIRED_MODEL)?.status).toBe(
      "superseded",
    );
    expect(
      await listSuggestions(ctx.db, {
        runId: await runCode(ctx.db, started.id),
        minConfidence: 0,
      }),
    ).toHaveLength(0);
    expect(
      await listSuggestions(ctx.db, {
        minConfidence: 0,
        entity: "product",
        recordIds: [product.id],
        fields: ["categoryId"],
      }),
    ).toHaveLength(0);
  });

  it("persists and applies the primary Addition when paired inference throws", async () => {
    const context = kernelCtx(ctx);
    const category = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic paired failure category",
    });
    const products = await Promise.all(
      [0, 1].map((index) =>
        productFixture(ctx, `Synthetic paired failure ${index}`),
      ),
    );
    const pairedTargets = new Set<string>();
    const suggest = vi.fn(async (_db, _runId, input, options) => {
      if (options?.decisionModel !== PRIMARY_MODEL) {
        pairedTargets.add(input.entityId!);
        throw new Error("paired model unavailable");
      }
      return suggestion(input.targets[0]!, {
        value: category.shortcode,
        label: category.name,
        probability: 0.95,
      });
    });
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: products.map((p) => p.id) },
      },
      { context, samplePair: () => true, suggest },
    );
    expect(pairedTargets).toEqual(new Set(products.map((p) => p.id)));
    const rows = await runSuggestions(ctx.db, started.id);
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row).toMatchObject({
        kind: "addition",
        status: "applied",
        model: PRIMARY_MODEL,
      });
    for (const product of products)
      expect(await productCategoryId(ctx.db, product.id)).toBe(category.id);
    const finished = await savedRun(ctx.db, started.id);
    expect(finished.progress).toMatchObject({
      applied: 2,
      diagnostics: [
        expect.objectContaining({ stage: "paired_model" }),
        expect.objectContaining({ stage: "paired_model" }),
      ],
    });
  });

  it("leaves an auto-apply candidate pending when the kernel write throws", async () => {
    const context = kernelCtx(ctx);
    const product = await productFixture(ctx, "Synthetic failed apply");
    const suggest = vi.fn(async () =>
      suggestion("categoryId", {
        value: "invalid-category-code",
        label: "Synthetic invalid category",
        probability: 0.97,
      }),
    );
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [product.id] },
      },
      { context, suggest },
    );
    expect(await runSuggestions(ctx.db, started.id)).toEqual([
      expect.objectContaining({ kind: "addition", status: "pending" }),
    ]);
    expect(await productCategoryId(ctx.db, product.id)).toBeNull();
    const finished = await savedRun(ctx.db, started.id);
    expect(finished.progress).toMatchObject({
      queued: 1,
      applied: 0,
      diagnostics: [expect.objectContaining({ stage: "apply" })],
    });
  });

  it("keeps a stale high-confidence Expense Addition pending during auto-apply", async () => {
    const context = kernelCtx(ctx);
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic stale category",
    });
    const expense = await expenseFixture(ctx.db, "Synthetic stale expense");
    const suggest = vi.fn(async () => {
      const review = await loadFinanceSuggestionContext(
        ctx.db,
        "expense",
        expense.shortcode,
      );
      // The evidence changes between inference and the auto-apply write.
      await getDb(ctx.db)
        .update(expenseTable)
        .set({ cost: 13 })
        .where(eq(expenseTable.id, expense.id));
      return suggestion("spendingCategoryId", {
        value: category.shortcode,
        label: category.name,
        probability: 0.95,
        financeReview: {
          entity: "expense",
          entityId: expense.shortcode,
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
        filters: { ids: [expense.shortcode] },
      },
      { context, suggest },
    );
    expect(await runSuggestions(ctx.db, started.id)).toEqual([
      expect.objectContaining({
        kind: "addition",
        status: "pending",
        confidence: 0.95,
      }),
    ]);
    const [savedExpense] = await getDb(ctx.db)
      .select({ spendingCategoryId: expenseTable.spendingCategoryId })
      .from(expenseTable)
      .where(eq(expenseTable.id, expense.id));
    expect(savedExpense?.spendingCategoryId).toBeNull();
    expect((await savedRun(ctx.db, started.id)).progress).toMatchObject({
      done: 1,
      queued: 1,
    });
  });
});
