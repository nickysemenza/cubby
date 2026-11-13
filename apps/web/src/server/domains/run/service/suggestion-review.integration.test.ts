import { entityFieldEnvelopeFields } from "@cubby/schemas/entity-field-envelopes";
import { fieldEnvelopeFor, fieldValueOf } from "@cubby/schemas/field-envelope";
import {
  basisValueOf,
  fieldSuggestionResolutionContext,
} from "@cubby/schemas/field-suggestion";
import { eq } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { seedFieldSuggestion } from "tooling/shared-suggestion-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { decisionCatalogRows } from "~/server/ai/decision-catalog";
import { withAiInputs } from "~/server/ai/evaluation-inputs";
import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { getDb } from "~/server/db/helpers";
import {
  suggestionTable,
  expense as expenseTable,
  vendor as vendorTable,
} from "~/server/db/schema";
import { loadFinanceSuggestionContext } from "~/server/domains/financial-transaction/repo/finance-suggestion-context";
import { inferFieldSuggestions } from "~/server/domains/run/operations/ai.server";
import { loadVendorSuggestionContext } from "~/server/domains/vendor/repo/vendor-suggestion-context";
import { executeEntity } from "~/server/entity-kernel";
import {
  reviewSuggestion,
  reviewSuggestionBatch,
} from "~/server/generic/suggestions/repo/review";
import { suggestionCountsByFamily } from "~/server/generic/suggestions/repo/suggestion-list";
import { publishExactSuggestion } from "~/server/generic/suggestions/repo/suggestion-publication";
import {
  acceptSuggestion,
  applyFieldCorrection,
} from "~/server/generic/suggestions/repo/suggestion-review";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";

import { ensureRun } from "../repo/ensure-run";
import { readReviewFields } from "./suggestion-sweep.fixtures";
import {
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
// suggested value; stale finance evidence is refused; unserved rows stay out
// of the review queue.
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
    const inference = await inferFieldSuggestions(
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
    expect(inference.suggestions.categoryId?.suggestionId).toBeDefined();
    expect(
      await readReviewFields(ctx.db, {
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
      await readReviewFields(ctx.db, {
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
    const first = await inferFieldSuggestions(
      kernelCtx(ctx),
      { ...input, runKey: crypto.randomUUID() },
      { ...categoryPorts(0.8).suggestPorts, decisionModel: PRIMARY_MODEL },
    );
    const id = first.suggestions.categoryId?.suggestionId;
    if (!id) throw new Error("Synthetic live suggestion missing");
    const repeat = await inferFieldSuggestions(
      kernelCtx(ctx),
      { ...input, runKey: crypto.randomUUID() },
      { ...categoryPorts(0.8).suggestPorts, decisionModel: PRIMARY_MODEL },
    );
    expect(repeat.suggestions.categoryId?.suggestionId).toBe(id);
    await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      suggestionId: id,
      operationId: "synthetic:live-wrong",
      verdict: "wrong",
      intent: "history",
    });
    const replay = await inferFieldSuggestions(
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
    const revised = await inferFieldSuggestions(
      kernelCtx(ctx),
      {
        ...input,
        runKey: crypto.randomUUID(),
        basis: { ...input.basis, name: "Synthetic revised live evidence" },
      },
      { ...categoryPorts(0.8).suggestPorts, decisionModel: PRIMARY_MODEL },
    );
    expect(revised.suggestions.categoryId?.suggestionId).toBeDefined();
    expect(revised.suggestions.categoryId?.suggestionId).not.toBe(id);
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
      const row = listed.items[0];
      const plain = z.record(z.string(), z.unknown()).parse(row);
      const governed = entityFieldEnvelopeFields.product;
      const basis = Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(row).filter((key) => key !== "fields"),
            ...Object.keys(governed),
          ]),
        ].map((key) => {
          const envelope = fieldEnvelopeFor(row, key);
          const value = Object.hasOwn(governed, key)
            ? envelope
              ? fieldValueOf(envelope)
              : null
            : plain[key];
          return [key, basisValueOf(value)];
        }),
      );
      const policy = decisionCatalogRows().find(
        (entry) => entry.entity === "product" && entry.field === "categoryId",
      );
      if (!policy) throw new Error("Synthetic category policy missing");
      basis.__resolutionContext = fieldSuggestionResolutionContext(row.fields, [
        ...policy.basis.map((entry) => entry.key),
        "categoryId",
      ]);
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
        inferFieldSuggestions(
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
      const id = live.result.suggestions.categoryId?.suggestionId;
      if (!id) throw new Error("Synthetic live suggestion missing");
      const [liveRow] = await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(eq(suggestionTable.id, id));
      if (!liveRow) throw new Error("Synthetic live history missing");
      const siblingId = crypto.randomUUID();
      await getDb(ctx.db)
        .insert(suggestionTable)
        .values({
          ...liveRow,
          id: siblingId,
          publicationKey: `synthetic-sibling:${siblingId}`,
          active: true,
          status: "pending",
        });
      const reviewed = await reviewSuggestion(ctx.db, kernelCtx(ctx), {
        suggestionId: id,
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
      const changed = await inferFieldSuggestions(
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
      expect(changed.suggestions.categoryId?.suggestionId).not.toBe(id);
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
          },
        ),
      );
      expect(stored.inputs).toEqual(live.inputs);
      expect(
        (
          await readReviewFields(ctx.db, {
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
    const [row] = await readReviewFields(ctx.db, {
      runId: await runCode(ctx.db, first.id),
      minConfidence: 0,
    });
    if (!row) throw new Error("Synthetic field suggestion missing");
    await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      suggestionId: row.id,
      operationId: "synthetic:wrong-field",
      verdict: "wrong",
      intent: "history",
    });
    await start();
    expect(
      await readReviewFields(ctx.db, {
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
      await readReviewFields(ctx.db, {
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
    const [row] = await readReviewFields(ctx.db, {
      runId: await runCode(ctx.db, runId),
      minConfidence: 0,
    });
    if (!row) throw new Error("Synthetic Suggestion was not persisted");
    expect(row.suggestedValue).toBe(taxonomyShortcode(SUGGESTED_CATEGORY));
    expect(
      await readReviewFields(ctx.db, {
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
    const sibling = await seedFieldSuggestion(
      ctx.db,
      {
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
      },
      true,
    );

    await acceptSuggestion(ctx.db, context, { id: row.id });
    await drainDerivedRefreshFrontier(ctx.db);
    expect(await suggestionStatus(ctx.db, row.id)).toBe("applied");
    expect(await suggestionStatus(ctx.db, sibling.id)).toBe("pending");
    expect(await productCategoryId(ctx.db, product.id)).toBe(
      taxonomyId(SUGGESTED_CATEGORY),
    );
    expect(
      await readReviewFields(ctx.db, {
        minConfidence: 0,
        entity: "product",
        recordIds: [product.id],
        fields: ["categoryId"],
      }),
    ).toHaveLength(0);
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
    const pending = await readReviewFields(ctx.db, {
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

    await reviewSuggestion(ctx.db, context, {
      suggestionId: dismissedRow.id,
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
      await readReviewFields(ctx.db, {
        runId: await runCode(ctx.db, runId),
        minConfidence: 0,
      }),
    ).toHaveLength(0);
    // Reviewed history is the decision-eval label set read over MCP.
    const history = await readReviewFields(ctx.db, {
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
      await readReviewFields(ctx.db, {
        entity: "product",
        recordIds: [dismissed.id, corrected.id],
        fields: ["categoryId"],
        status: "rejected",
        minConfidence: 0,
      }),
    ).toHaveLength(2);
    await expect(
      readReviewFields(ctx.db, { recordIds: [dismissed.id] }),
    ).rejects.toThrow(/name its entity/);
    expect(
      await readReviewFields(ctx.db, {
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
    const pending = await readReviewFields(ctx.db, {
      runId: code,
      minConfidence: 0,
    });
    const idFor = (recordId: string) =>
      pending.find((row) => row.recordId === recordId)?.id ?? "";
    const [listed] = await getDb(ctx.db)
      .select({ fingerprint: suggestionTable.fingerprint })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, idFor(accepted.id)));
    const accept = await reviewSuggestionBatch(ctx.db, context, {
      items: [
        {
          suggestionId: idFor(accepted.id),
          operationId: crypto.randomUUID(),
          verdict: "correct",
          intent: "apply",
          expectedFingerprint: listed?.fingerprint ?? idFor(accepted.id),
        },
      ],
    });
    expect(accept).toEqual([
      expect.objectContaining({
        suggestionId: idFor(accepted.id),
        ok: true,
        status: "applied",
        applied: true,
      }),
    ]);
    // The already-applied id fails on its own; the pending one still rejects.
    const reject = await reviewSuggestionBatch(ctx.db, context, {
      items: [
        {
          suggestionId: idFor(accepted.id),
          operationId: crypto.randomUUID(),
          verdict: "correct",
          intent: "apply",
          expectedFingerprint: "synthetic-stale-fingerprint",
        },
        {
          suggestionId: idFor(rejected.id),
          operationId: crypto.randomUUID(),
          verdict: "wrong",
          intent: "history",
        },
      ],
    });
    expect(reject).toEqual([
      expect.objectContaining({ suggestionId: idFor(accepted.id), ok: false }),
      expect.objectContaining({
        suggestionId: idFor(rejected.id),
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
    const { families } = await suggestionCountsByFamily(ctx.db, {
      family: "field",
      runId: code,
    });
    expect(families).toEqual([
      expect.objectContaining({
        family: "field",
        pending: 0,
        applied: 1,
        rejected: 1,
        fields: [
          expect.objectContaining({
            entity: "product",
            field: "categoryId",
            pending: 0,
            applied: 1,
            rejected: 1,
          }),
        ],
      }),
    ]);
  });

  it("records a per-record wrong verdict as a Miss on its ai_suggest Run", async () => {
    const context = kernelCtx(ctx);
    const product = await productFixture(ctx, "Synthetic dismissed item", {
      categoryId: taxonomyId("tools"),
    });
    const runId = await ensureRun(ctx.db, context.actorContext, {
      purpose: "ai_suggest",
      clientKey: crypto.randomUUID(),
    });
    const prediction = await publishExactSuggestion(
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
    await reviewSuggestion(ctx.db, context, {
      suggestionId: prediction.id,
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
    const [row] = await readReviewFields(ctx.db, {
      runId: await runCode(ctx.db, started.id),
      minConfidence: 0,
    });
    if (!row) throw new Error("Synthetic finance suggestion was not persisted");
    await getDb(ctx.db)
      .update(expenseTable)
      .set({ cost: 1300n })
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

  it("fills an eligible Vendor default category with Expense history at 95% and keeps one below threshold reviewable", async () => {
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
        // Expense history only freshness-checks the proposal; confidence decides fill.
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

    const pending = await readReviewFields(ctx.db, {
      runId: await runCode(ctx.db, started.id),
      minConfidence: 0,
    });
    expect(pending.map(({ recordId }) => recordId)).toEqual([
      reviewedVendor.shortcode,
    ]);
    for (const row of pending)
      await acceptSuggestion(ctx.db, context, { id: row.id });
    expect(await vendorCategory(autoVendor.id)).toBe(category.id);
    expect(await vendorCategory(reviewedVendor.id)).toBe(category.id);
    expect(
      (await runSuggestions(ctx.db, started.id)).map(({ status }) => status),
    ).toEqual(["applied", "applied"]);
  });
});
