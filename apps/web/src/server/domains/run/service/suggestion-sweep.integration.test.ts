import { systemActor } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { readEvaluationOutcomes } from "~/server/ai/evaluation/repo/evaluation-tally";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  auditLog,
  expense as expenseTable,
  run as runTable,
  vendor as vendorTable,
  product as productTable,
} from "~/server/db/schema";
import { loadFinanceSuggestionContext } from "~/server/domains/financial-transaction/repo/finance-suggestion-context";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { declaredFilterPredicates } from "~/server/generic/list/repo/list";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { readSuggestionDecisions } from "~/server/testing/suggestion-decisions.fixtures";
import { controlWorkflowRun } from "~/server/workflows/runs/control";

import {
  PRIMARY_MODEL,
  SUGGESTED_CATEGORY,
  categoryPorts,
  expenseFixture,
  kernelCtx,
  noProposal,
  productCategoryId,
  productFixture,
  recordId,
  resumeSuggestionSweep,
  runSuggestions,
  runCode,
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

async function evaluationProgress(
  db: Parameters<typeof getDb>[0],
  id: Parameters<typeof runSuggestions>[1],
) {
  const { tally, ...outcomes } = await readEvaluationOutcomes(db, {
    runId: id,
    source: "requested",
  });
  return {
    ...outcomes,
    total: tally.total,
    done: tally.total - tally.pending,
    failed: tally.failed,
  };
}

// Regression modes: an empty-field Addition above threshold publishes pending
// and then applies only through the field.addition policy, as automatic
// Feedback naming it, without a measured audit holdback; Corrections and
// low-confidence assignments remain pending; pause/resume checkpoints by
// unprocessed record and field.
describe("persisted Suggestion sweeps", () => {
  const ctx = withTestDb();

  // Without an automatic Run model pin, inferring served status from the Run
  // hid the answer and published its history as unserved.
  it("keeps principal Expense context eligible for Project inference", async () => {
    await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic garden supplies",
    });
    const expense = await expenseFixture(ctx.db, "Synthetic garden supplies");
    let calls = 0;
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "expense",
        fields: ["projectId"],
        filters: { ids: [expense.shortcode] },
      },
      {
        context: kernelCtx(ctx),
        suggestPorts: {
          recordUsage: false,
          decisionPort: async (request) => {
            calls++;
            const keys = Object.keys(request.questions.selection.criteria);
            return {
              answers: {
                selection: {
                  type: "choice",
                  choice: "none",
                  confidence: 0.9,
                  probabilities: Object.fromEntries(
                    keys.map((key) => [
                      key,
                      key === "none" ? 0.9 : 0.1 / Math.max(1, keys.length - 1),
                    ]),
                  ),
                },
              },
            };
          },
        },
      },
    );
    expect(calls).toBeGreaterThan(0);
  });

  it("keeps the answer visible without a Run model pin", async () => {
    const item = await productFixture(ctx, "Synthetic input-routed item");
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      {
        context: kernelCtx(ctx),
        ...categoryPorts(0.7),
        decisionModel: undefined,
      },
    );
    const rows = await runSuggestions(ctx.db, started.id);
    expect(rows).toHaveLength(1);
    const visible = await getDb(ctx.db)
      .select({ id: productTable.id })
      .from(productTable)
      .where(
        and(
          eq(productTable.id, await recordId(ctx.db, item.id, "product")),
          ...declaredFilterPredicates("product", productTable, {
            suggestionKind: "addition",
          }),
        ),
      );
    expect(visible).toHaveLength(1);
    const run = await savedRun(ctx.db, started.id);
    expect(run.input).not.toHaveProperty("decisionModel");
  });

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
      reason: "confident_assignment",
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
    expect(audits.map((audit) => audit.userId)).toEqual(
      audits.map(() => systemActor().userId),
    );
    const events = await readSuggestionDecisions(ctx.db, row!.id);
    const rule = {
      key: "field.addition",
      revision: expect.any(String),
      stamp: expect.stringMatching(/^field\.addition@/),
    };
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "correct",
          authority: "automatic",
          actorUserId: systemActor().userId,
          metadata: expect.objectContaining({
            kind: "assessment_review",
            rule,
          }),
        }),
        expect.objectContaining({
          verdict: "ungraded",
          authority: "automatic",
          metadata: expect.objectContaining({
            kind: "assessment_application",
            rule,
          }),
        }),
      ]),
    );
    expect(events.some((event) => event.authority === "member")).toBe(false);
  });

  it("checkpoints no-proposal targets by public id and field for filter-selected rows only", async () => {
    const context = kernelCtx(ctx);
    const matching = await productFixture(ctx, "Synthetic selected product");
    await productFixture(ctx, "Synthetic unselected product", {
      brandId: await findOrCreateVendor(ctx.db, "Other maker"),
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
        filters: { ids: [matching.id] },
      },
      { context, suggest, pauseAfter: 1 },
    );
    expect(processed).toEqual([{ id: matching.id, field: "categoryId" }]);

    await resumeSuggestionSweep(ctx.db, started.id, { context, suggest });
    expect(processed).toEqual([
      { id: matching.id, field: "categoryId" },
      { id: matching.id, field: "tags" },
    ]);
    const finished = await savedRun(ctx.db, started.id);
    expect(finished.status).toBe("completed");
    expect(await evaluationProgress(ctx.db, started.id)).toMatchObject({
      done: 2,
      total: 2,
      queued: 0,
      applied: 0,
      failed: 0,
    });
    expect(
      await getDb(ctx.db)
        .select({ state: aiEvaluation.state, receipt: aiEvaluation.receipt })
        .from(aiEvaluation)
        .where(eq(aiEvaluation.runId, started.id)),
    ).toEqual([
      {
        state: "completed",
        receipt: expect.objectContaining({ outcome: "settled" }),
      },
      {
        state: "completed",
        receipt: expect.objectContaining({ outcome: "settled" }),
      },
    ]);
    expect(await runSuggestions(ctx.db, started.id)).toEqual([]);

    await expect(
      resumeSuggestionSweep(ctx.db, started.id, { context, suggest }),
    ).rejects.toThrow(/Only paused AI work can be resumed/);
    expect(processed).toHaveLength(2);
  });

  it("retains evaluation models, applies Additions and resumes a paused filtered sweep", async () => {
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
        filters: { categoryIdPresenceFilter: "none" },
      },
      { context, pauseAfter: 1, ...categoryPorts() },
    );
    const paused = await savedRun(ctx.db, started.id);
    expect(paused.purpose).toBe("sweep");
    expect(paused.status).toBe("paused");
    expect(paused.input).toMatchObject({
      kind: "sweep",
      families: [
        {
          family: "field",
          scope: {
            targets: [
              {
                entity: "product",
                fields: ["categoryId"],
                filters: { categoryIdPresenceFilter: "none" },
              },
            ],
          },
        },
      ],
    });
    // The test driver pauses before the Run's progress checkpoint is written;
    // count settled evaluations instead.
    expect(
      (
        await getDb(ctx.db)
          .select({ state: aiEvaluation.state })
          .from(aiEvaluation)
          .where(eq(aiEvaluation.runId, started.id))
      ).filter((row) => row.state === "completed"),
    ).toHaveLength(1);

    await expect(
      controlWorkflowRun(
        ctx.db,
        context.actorContext,
        { runPublicId: await runCode(ctx.db, started.id), action: "pause" },
        "sweep",
      ),
    ).rejects.toThrow("Only running member-requested AI work can be paused");
    const [stale] = await getDb(ctx.db)
      .select({ id: aiEvaluation.id, target: aiEvaluation.target })
      .from(aiEvaluation)
      .where(
        and(
          eq(aiEvaluation.runId, started.id),
          eq(aiEvaluation.state, "queued"),
        ),
      );
    if (!stale || stale.target.entity !== "product")
      throw new Error("Synthetic queued Product is missing");
    const staleProductId = parseEntityId("product", stale.target.recordId);
    await getDb(ctx.db)
      .update(productTable)
      .set({ name: "Synthetic changed queued item" })
      .where(eq(productTable.id, staleProductId));
    const ports = categoryPorts();
    const decide = vi.fn(ports.suggestPorts.decisionPort);
    await resumeSuggestionSweep(ctx.db, started.id, {
      context,
      ...ports,
      suggestPorts: { ...ports.suggestPorts, decisionPort: decide },
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, stale.id))
      )[0],
    ).toMatchObject({
      state: "obsolete",
      attempts: 0,
      receipt: { reason: "Suggestion basis changed after queuing" },
    });
    const finished = await savedRun(ctx.db, started.id);
    expect(finished.status).toBe("completed");
    expect(await evaluationProgress(ctx.db, started.id)).toMatchObject({
      total: 3,
      done: 3,
      applied: 2,
      queued: 0,
      failed: 0,
    });
    const rows = await runSuggestions(ctx.db, started.id);
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row).toMatchObject({
        kind: "addition",
        status: "applied",
        model: PRIMARY_MODEL,
        suggestedValue: taxonomyShortcode(SUGGESTED_CATEGORY),
      });
    for (const product of products)
      expect(await productCategoryId(ctx.db, product.id)).toBe(
        (await recordId(ctx.db, product.id, "product")) === staleProductId
          ? null
          : taxonomyId(SUGGESTED_CATEGORY),
      );
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

  // Derived current values participate in equality; a different review-only proposal stays pending.
  it.each([
    { value: "required", expected: [] },
    {
      value: "not_expected",
      expected: [{ kind: "correction", status: "pending", confidence: 0.97 }],
    },
  ])(
    "compares Vendor item-line advice $value against its effective value",
    async ({ value, expected }) => {
      const context = kernelCtx(ctx);
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic online shop",
        orderEvidence: "online_account",
      });
      const suggest = vi.fn(async () =>
        suggestion("itemizationExpectation", {
          value,
          label: "Expected",
          probability: 0.97,
        }),
      );
      const started = await startSuggestionSweep(
        ctx.db,
        {
          entity: "vendor",
          fields: ["itemizationExpectation"],
          filters: { ids: [vendor.shortcode] },
        },
        { context, suggest },
      );
      expect(
        (await runSuggestions(ctx.db, started.id)).map(
          ({ kind, status, confidence }) => ({ kind, status, confidence }),
        ),
      ).toEqual(expected);
      const [stored] = await getDb(ctx.db)
        .select({ value: vendorTable.itemizationExpectation })
        .from(vendorTable)
        .where(eq(vendorTable.id, vendor.id));
      expect(stored?.value).toBeNull();
    },
  );

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
    const [pending] = await runSuggestions(ctx.db, started.id);
    expect(pending).toMatchObject({ kind: "addition", status: "pending" });
    // A refused automatic application leaves no Feedback: nobody reviewed it.
    expect(await readSuggestionDecisions(ctx.db, pending!.id)).toEqual([]);
    expect(await productCategoryId(ctx.db, product.id)).toBeNull();
    expect(await evaluationProgress(ctx.db, started.id)).toMatchObject({
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
    expect(await evaluationProgress(ctx.db, started.id)).toMatchObject({
      done: 1,
      queued: 1,
    });
  });
});
