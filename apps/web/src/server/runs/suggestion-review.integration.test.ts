import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import {
  expense as expenseTable,
  suggestion as suggestionTable,
  vendor as vendorTable,
} from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import { getDb } from "~/server/repo/database-helpers";
import { loadFinanceSuggestionContext } from "~/server/repo/finance-suggestion-context";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  acceptSuggestion,
  listPagePendingSuggestions,
  listSuggestions,
  recordFieldSuggestionMiss,
  rejectSuggestion,
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

  it("accepts a persisted Suggestion through the entity kernel, applies its value and supersedes siblings", async () => {
    const context = kernelCtx(ctx);
    const product = await productFixture(ctx, "Synthetic accepted item", {
      categoryId: taxonomyId("tools"),
    });
    const runId = await sweepCategories([product.id]);
    const [row] = await listSuggestions(ctx.db, {
      runId,
      minConfidence: 0,
    });
    if (!row) throw new Error("Synthetic Suggestion was not persisted");
    expect(row.suggestedValue).toBe(taxonomyShortcode(SUGGESTED_CATEGORY));
    expect(
      await listPagePendingSuggestions(ctx.db, {
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
      await listPagePendingSuggestions(ctx.db, {
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
    const pending = await listSuggestions(ctx.db, {
      runId,
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

    await rejectSuggestion(ctx.db, context, { id: dismissedRow.id });
    await rejectSuggestion(ctx.db, context, {
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
      await listSuggestions(ctx.db, { runId, minConfidence: 0 }),
    ).toHaveLength(0);
    // Reviewed history is the decision-eval label set read over MCP.
    const history = await listSuggestions(ctx.db, {
      runId,
      minConfidence: 0,
      status: "rejected",
    });
    expect(history.map(({ correctValue }) => correctValue).sort()).toEqual(
      [null, taxonomyShortcode("household")].sort(),
    );
    expect(
      await listPagePendingSuggestions(ctx.db, {
        entity: "product",
        recordIds: [dismissed.id, corrected.id],
        fields: ["categoryId"],
      }),
    ).toHaveLength(0);
  });

  it("records a per-record dismissal as a Miss on its ai_suggest Run", async () => {
    const context = kernelCtx(ctx);
    const product = await productFixture(ctx, "Synthetic dismissed item", {
      categoryId: taxonomyId("tools"),
    });
    const runId = await ensureRun(
      ctx.db,
      context.actorContext,
      aiCallRunInput(context.actorContext, { runKey: crypto.randomUUID() }),
    );
    await recordFieldSuggestionMiss(ctx.db, runId, {
      entity: "product",
      entityId: product.id,
      field: "categoryId",
      currentValue: taxonomyShortcode("tools"),
      suggestedValue: taxonomyShortcode("food"),
      confidence: 0.91,
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
      runId: started.id,
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
      runId: started.id,
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
