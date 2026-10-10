import { fieldSuggestionsOut } from "@cubby/schemas/ai";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { suggestionSweepRunProgress } from "@cubby/schemas/run-fields";
import { eq } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { ReferenceSuggestSpec } from "~/server/ai/field-suggest/registry";
import type { JevPort } from "~/server/ai/jev";
import {
  product as productTable,
  expense as expenseTable,
  run as runTable,
  suggestion as suggestionTable,
  vendor as vendorTable,
} from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel/adapter";
import { getDb } from "~/server/repo/database-helpers";
import { loadFinanceSuggestionContext } from "~/server/repo/finance-suggestion-context";
import { createProduct } from "~/server/repo/product/crud";
import { makeProductInput } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  acceptSuggestion,
  listPendingSuggestions,
  listPagePendingSuggestions,
  rejectSuggestion,
  recordFieldSuggestionMiss,
  summarizeSuggestionMisses,
} from "~/server/repo/suggestion-review";
import { loadVendorSuggestionContext } from "~/server/repo/vendor-suggestion-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { aiCallRunInput, ensureRun } from "./ensure-run";
import {
  startSuggestionSweep,
  resumeSuggestionSweep,
  pauseSuggestionSweep,
} from "./suggestion-sweep";

type CategoryCandidate = { id: string; title: string };
const categorySpec: ReferenceSuggestSpec<CategoryCandidate> = {
  kind: "reference",
  entity: "productCategory",
  rules: "Choose the category.",
  maxCandidates: 5,
  roster: async () => [
    { id: taxonomyShortcode("food"), title: "Synthetic food" },
  ],
  idOf: (candidate) => candidate.id,
  labelOf: (candidate) => candidate.title,
  renderLine: ({ id, title }) => `${id} | ${title}`,
  subject: (basis) => `Product: ${basis.name ?? ""}`,
};
const decisionAt =
  (confidence: number): JevPort =>
  async (input) => {
    const keys = Object.keys(input.questions.selection.criteria);
    const choice = keys[0]!;
    return {
      answers: {
        selection: {
          type: "choice",
          choice,
          confidence,
          probabilities: Object.fromEntries(
            keys.map((key) => [
              key,
              key === choice
                ? confidence
                : (1 - confidence) / Math.max(1, keys.length - 1),
            ]),
          ),
        },
      },
    };
  };
const highConfidence = decisionAt(0.97);

// Regression modes: an Addition above threshold applies through the entity
// kernel; Corrections and low confidence remain pending; paired decisions
// share provenance and never apply; pause/resume checkpoints by unprocessed row.
describe("persisted Suggestion sweeps", () => {
  const ctx = withTestDb();

  it("uses public ids for finance inference and checkpoints no-proposal targets", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const expenses = await Promise.all(
      ["Alpha", "Beta"].map((name) =>
        insertWithShortcode(ctx.db, "expense", {
          name: `Synthetic ${name} expense`,
          cost: 12,
          date: "2026-09-01",
          costType: "materials",
          trade: "other",
        }),
      ),
    );
    const seen: string[] = [];
    const suggest = vi.fn(async (_db, _runId, input) => {
      seen.push(input.entityId!);
      const target = input.targets[0]!;
      return fieldSuggestionsOut.parse({
        suggestions: { [target]: null },
        outcomes: {
          [target]: {
            kind: "evaluated" as const,
            answer: "none" as const,
            confidence: "high" as const,
            probability: 0.9,
            alternatives: [],
          },
        },
      });
    });
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "expense",
        field: "spendingCategoryId",
        filters: { ids: expenses.map(({ shortcode }) => shortcode) },
      },
      {
        context,
        decisionModel: () => "typesafe/jev",
        suggest,
        pauseAfter: 1,
        wait: async () => {},
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(
      expenses.find(({ shortcode }) => shortcode === seen[0])?.shortcode,
    );
    await resumeSuggestionSweep(ctx.db, started.id, {
      context,
      decisionModel: () => "typesafe/jev",
      suggest,
      wait: async () => {},
    });
    expect(seen).toHaveLength(2);
    expect(new Set(seen)).toEqual(
      new Set(expenses.map(({ shortcode }) => shortcode)),
    );
    const [saved] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, started.id));
    expect(saved?.progress).toMatchObject({ done: 2, total: 2 });
    await expect(
      resumeSuggestionSweep(ctx.db, started.id, {
        context,
        suggest,
        wait: async () => {},
      }),
    ).rejects.toThrow(/completed suggestion sweep/i);
    expect(seen).toHaveLength(2);
  });

  it("refuses accepting a finance suggestion after its inference evidence changes", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic review category",
    });
    const line = await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic reviewed expense",
      cost: 12,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
    });
    const suggest = vi.fn(async () =>
      fieldSuggestionsOut.parse({
        suggestions: {
          spendingCategoryId: {
            value: category.shortcode,
            label: category.name,
            detail: null,
            confidence: "medium",
            probability: 0.7,
            reasoning: "Synthetic evidence review",
            alternatives: [],
            financeReview: {
              entity: "expense" as const,
              entityId: line.shortcode,
              field: "spendingCategoryId" as const,
              fingerprint: "a".repeat(64),
            },
          },
        },
      }),
    );
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "expense",
        field: "spendingCategoryId",
        filters: { ids: [line.shortcode] },
      },
      {
        context,
        decisionModel: () => "typesafe/jev",
        suggest,
        wait: async () => {},
      },
    );
    const [row] = await listPendingSuggestions(ctx.db, {
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
  });

  it("accepts a Vendor default category through reviewed finance apply with Expense history", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic vendor category",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic reviewed vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic vendor expense",
      cost: 12,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
      purchaseId: purchase.id,
    });
    const review = await loadVendorSuggestionContext(ctx.db, vendor.shortcode);
    const suggest = vi.fn(async () =>
      fieldSuggestionsOut.parse({
        suggestions: {
          defaultSpendingCategoryId: {
            value: category.shortcode,
            label: category.name,
            detail: null,
            confidence: "medium",
            probability: 0.7,
            reasoning: "Synthetic vendor review",
            alternatives: [],
            financeReview: {
              entity: "vendor" as const,
              entityId: vendor.shortcode,
              field: "defaultSpendingCategoryId" as const,
              fingerprint: review.fingerprint,
            },
          },
        },
      }),
    );
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "vendor",
        field: "defaultSpendingCategoryId",
        filters: { ids: [vendor.shortcode] },
      },
      {
        context,
        decisionModel: () => "typesafe/jev",
        suggest,
        wait: async () => {},
      },
    );
    const [row] = await listPendingSuggestions(ctx.db, {
      runId: started.id,
      minConfidence: 0,
    });
    if (!row) throw new Error("Synthetic Vendor suggestion was not persisted");
    await acceptSuggestion(ctx.db, context, { id: row.id });
    const [saved] = await getDb(ctx.db)
      .select({
        defaultSpendingCategoryId: vendorTable.defaultSpendingCategoryId,
      })
      .from(vendorTable)
      .where(eq(vendorTable.id, vendor.id));
    expect(saved?.defaultSpendingCategoryId).toBe(category.id);
  });

  it("leaves an auto-apply candidate pending when the kernel write throws", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic failed apply",
        manufacturer: "Synthetic maker",
      }),
      ctx.actor,
    );
    const suggest = vi.fn(async () =>
      fieldSuggestionsOut.parse({
        suggestions: {
          categoryId: {
            value: "invalid-category-code",
            label: "Synthetic invalid category",
            detail: null,
            confidence: "high",
            probability: 0.97,
            reasoning: "Synthetic failed apply",
            alternatives: [],
          },
        },
      }),
    );
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        field: "categoryId",
        filters: { ids: [product.id] },
      },
      {
        context,
        decisionModel: () => "typesafe/jev",
        suggest,
        wait: async () => {},
      },
    );
    const [row] = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, started.id));
    expect(row?.status).toBe("pending");
  });

  it("persists pinned model, progress and Suggestions, and resumes a paused batch", async () => {
    const context = createTestRequestContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    });
    await Promise.all(
      ["Alpha", "Beta", "Gamma"].map((name) =>
        createProduct(
          ctx.db,
          makeProductInput({
            name: `Synthetic ${name}`,
            manufacturer: "Synthetic maker",
          }),
          ctx.actor,
        ),
      ),
    );
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        field: "categoryId",
        filters: {},
      },
      {
        context: entityKernelContextSchema.parse(context),
        decisionModel: () => "typesafe/jev",
        pauseAfter: 2,
        wait: async () => {},
        suggestPorts: {
          jev: vi.fn(highConfidence),
          registry: { "product.categoryId": categorySpec },
        },
      },
    );
    expect(started.id).toBeTruthy();
    const db = getDb(ctx.db);
    const [saved] = await db
      .select()
      .from(runTable)
      .where(eq(runTable.id, started.id));
    expect(saved?.purpose).toBe("suggestion_sweep");
    expect(saved?.input).toMatchObject({
      entity: "product",
      field: "categoryId",
      filters: {},
      decisionModel: "typesafe/jev",
    });
    expect(saved?.progress).toMatchObject({
      total: expect.any(Number),
      done: 2,
      applied: expect.any(Number),
      queued: expect.any(Number),
      failed: expect.any(Number),
    });
    const pausedProgress = suggestionSweepRunProgress.parse(saved?.progress);
    expect(
      pausedProgress.applied + pausedProgress.queued + pausedProgress.failed,
    ).toBe(pausedProgress.done);
    expect(saved?.input).toMatchObject({ paused: true });
    await pauseSuggestionSweep(ctx.db, started.id);
    await resumeSuggestionSweep(ctx.db, started.id, {
      context: entityKernelContextSchema.parse(context),
      wait: async () => {},
      suggestPorts: {
        jev: vi.fn(highConfidence),
        registry: { "product.categoryId": categorySpec },
      },
    });
    const [finished] = await db
      .select()
      .from(runTable)
      .where(eq(runTable.id, started.id));
    expect(finished?.status).toBe("completed");
    expect(finished?.progress).toMatchObject({
      done: suggestionSweepRunProgress.parse(finished?.progress).total,
    });
    const rows = await db
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, started.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.some(
        (row) =>
          row.status === "applied" &&
          row.kind === "addition" &&
          row.confidence >= 0.85,
      ),
    ).toBe(true);
    const appliedRow = rows.find((row) => row.status === "applied")!;
    const [visible] = await db
      .select({ categoryId: productTable.categoryId })
      .from(productTable)
      .where(
        eq(productTable.id, parseEntityId("product", appliedRow.recordId)),
      );
    expect(visible?.categoryId).not.toBeNull();
  });

  it("keeps a high-confidence Correction and a low-confidence Addition pending", async () => {
    const context = createTestRequestContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    });
    const toolCategoryId = await resolveLiveShortcode(
      ctx.db,
      taxonomyShortcode("tools"),
      "productCategory",
    );
    if (!toolCategoryId) throw new Error("synthetic category setup failed");
    const correction = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic corrected item",
        manufacturer: "Synthetic maker",
        categoryId: parseEntityId("productCategory", toolCategoryId),
      }),
      ctx.actor,
    );
    const addition = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic low-confidence item",
        manufacturer: "Synthetic maker",
      }),
      ctx.actor,
    );
    const correctionId = await resolveLiveShortcode(
      ctx.db,
      correction.id,
      "product",
    );
    const additionId = await resolveLiveShortcode(
      ctx.db,
      addition.id,
      "product",
    );
    const runId = (
      await startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          field: "categoryId",
          filters: { ids: [correction.id] },
        },
        {
          context: entityKernelContextSchema.parse(context),
          decisionModel: () => "typesafe/jev",
          wait: async () => {},
          suggestPorts: {
            jev: vi.fn(highConfidence),
            registry: { "product.categoryId": categorySpec },
          },
        },
      )
    ).id;
    const db = getDb(ctx.db);
    const [correctionRow] = await db
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, runId));
    expect(correctionRow).toMatchObject({
      kind: "correction",
      status: "pending",
      confidence: 0.97,
    });
    if (!correctionId || !additionId || !toolCategoryId)
      throw new Error("synthetic record setup failed");
    const [unchanged] = await db
      .select({ categoryId: productTable.categoryId })
      .from(productTable)
      .where(eq(productTable.id, parseEntityId("product", correctionId)));
    expect(unchanged?.categoryId).toBe(toolCategoryId);
    const lowRunId = (
      await startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          field: "categoryId",
          filters: { ids: [addition.id] },
        },
        {
          context: entityKernelContextSchema.parse(context),
          decisionModel: () => "typesafe/jev",
          wait: async () => {},
          suggestPorts: {
            jev: vi.fn(decisionAt(0.6)),
            registry: { "product.categoryId": categorySpec },
          },
        },
      )
    ).id;
    const [lowRow] = await db
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, lowRunId));
    expect(lowRow).toMatchObject({
      kind: "addition",
      status: "pending",
      confidence: 0.6,
    });
    const current = await db
      .select({ id: productTable.id, categoryId: productTable.categoryId })
      .from(productTable)
      .where(eq(productTable.id, parseEntityId("product", additionId)));
    expect(current[0]?.categoryId).toBeNull();
    expect(correctionId).toBeTruthy();
  });

  it("stores a paired model row under one pair key without applying it", async () => {
    const context = createTestRequestContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    });
    const ids: string[] = [];
    for (let index = 0; index < 20; index++) {
      const product = await createProduct(
        ctx.db,
        makeProductInput({
          name: `Synthetic paired item ${index}`,
          manufacturer: "Synthetic maker",
        }),
        ctx.actor,
      );
      ids.push(product.id);
    }
    const runId = (
      await startSuggestionSweep(
        ctx.db,
        { entity: "product", field: "categoryId", filters: { ids } },
        {
          context: entityKernelContextSchema.parse(context),
          decisionModel: () => "typesafe/jev",
          wait: async () => {},
          suggestPorts: {
            jev: vi.fn(highConfidence),
            registry: { "product.categoryId": categorySpec },
          },
        },
      )
    ).id;
    const db = getDb(ctx.db);
    const rows = await db
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, runId));
    const pairedRows = rows.filter((row) => row.pairKey !== null);
    expect(pairedRows.length).toBeGreaterThan(0);
    const reviewQueue = await listPendingSuggestions(ctx.db, {
      runId,
      minConfidence: 0,
    });
    expect(reviewQueue).toHaveLength(0);
    expect(
      await listPagePendingSuggestions(ctx.db, {
        entity: "product",
        recordIds: [...new Set(rows.map((row) => row.recordId))],
        fields: ["categoryId"],
      }),
    ).toHaveLength(0);
    for (const pairKey of new Set(pairedRows.map((row) => row.pairKey))) {
      const pair = pairedRows.filter((row) => row.pairKey === pairKey);
      expect(pair).toHaveLength(2);
      expect(pair.filter((row) => row.model === "typesafe/jev")).toHaveLength(
        1,
      );
      expect(pair.find((row) => row.model !== "typesafe/jev")?.status).toBe(
        "pending",
      );
    }
  });

  it("keeps a stale high-confidence Expense Addition pending during auto-apply", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic stale category",
    });
    const expense = await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic stale expense",
      cost: 12,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
    });
    const suggest = vi.fn(async () => {
      const review = await loadFinanceSuggestionContext(
        ctx.db,
        "expense",
        expense.shortcode,
      );
      await getDb(ctx.db)
        .update(expenseTable)
        .set({ cost: 13 })
        .where(eq(expenseTable.id, expense.id));
      return fieldSuggestionsOut.parse({
        suggestions: {
          spendingCategoryId: {
            value: category.shortcode,
            label: category.name,
            detail: null,
            confidence: "high",
            probability: 0.95,
            reasoning: "Synthetic stale evidence",
            alternatives: [],
            financeReview: {
              entity: "expense" as const,
              entityId: expense.shortcode,
              field: "spendingCategoryId" as const,
              fingerprint: review.fingerprint,
            },
          },
        },
      });
    });
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "expense",
        field: "spendingCategoryId",
        filters: { ids: [expense.shortcode] },
      },
      {
        context,
        decisionModel: () => "typesafe/jev",
        suggest,
        wait: async () => {},
      },
    );
    const [row] = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, started.id));
    const [savedExpense] = await getDb(ctx.db)
      .select({ spendingCategoryId: expenseTable.spendingCategoryId })
      .from(expenseTable)
      .where(eq(expenseTable.id, expense.id));
    const [savedRun] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, started.id));
    expect(row).toMatchObject({
      kind: "addition",
      status: "pending",
      confidence: 0.95,
    });
    expect(savedExpense?.spendingCategoryId).toBeNull();
    expect(savedRun?.progress).toMatchObject({ done: 1, queued: 1 });
  });

  it("auto-applies a Vendor default category with Expense history through reviewed apply", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic auto vendor category",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic auto vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic auto vendor expense",
      cost: 12,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
      purchaseId: purchase.id,
    });
    const review = await loadVendorSuggestionContext(ctx.db, vendor.shortcode);
    const suggest = vi.fn(async () =>
      fieldSuggestionsOut.parse({
        suggestions: {
          defaultSpendingCategoryId: {
            value: category.shortcode,
            label: category.name,
            detail: null,
            confidence: "high",
            probability: 0.95,
            reasoning: "Synthetic vendor evidence",
            alternatives: [],
            financeReview: {
              entity: "vendor" as const,
              entityId: vendor.shortcode,
              field: "defaultSpendingCategoryId" as const,
              fingerprint: review.fingerprint,
            },
          },
        },
      }),
    );
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "vendor",
        field: "defaultSpendingCategoryId",
        filters: { ids: [vendor.shortcode] },
      },
      {
        context,
        decisionModel: () => "typesafe/jev",
        suggest,
        wait: async () => {},
      },
    );
    const [row] = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, started.id));
    const [savedVendor] = await getDb(ctx.db)
      .select({
        defaultSpendingCategoryId: vendorTable.defaultSpendingCategoryId,
      })
      .from(vendorTable)
      .where(eq(vendorTable.id, vendor.id));
    expect(row?.status).toBe("applied");
    expect(savedVendor?.defaultSpendingCategoryId).toBe(category.id);
  });

  it("keeps resumed filtered progress total equal to done after applying targets", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const products = await Promise.all(
      ["First", "Second"].map((name) =>
        createProduct(
          ctx.db,
          makeProductInput({
            name: `Synthetic ${name} filtered`,
            manufacturer: "Synthetic maker",
          }),
          ctx.actor,
        ),
      ),
    );
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        field: "categoryId",
        filters: {
          ids: products.map((p) => p.id),
          categoryPresenceFilter: "none",
        },
      },
      {
        context,
        decisionModel: () => "typesafe/jev",
        pauseAfter: 1,
        wait: async () => {},
        suggestPorts: {
          jev: vi.fn(highConfidence),
          registry: { "product.categoryId": categorySpec },
        },
      },
    );
    await resumeSuggestionSweep(ctx.db, started.id, {
      context,
      wait: async () => {},
      suggestPorts: {
        jev: vi.fn(highConfidence),
        registry: { "product.categoryId": categorySpec },
      },
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, started.id));
    expect(saved?.progress).toMatchObject({ done: 2, total: 2 });
  });

  it("persists and applies the primary Addition when paired inference throws", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const category = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic paired failure category",
    });
    const products = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createProduct(
          ctx.db,
          makeProductInput({
            name: `Synthetic paired failure ${index}`,
            manufacturer: "Synthetic maker",
          }),
          ctx.actor,
        ),
      ),
    );
    const pairedTargets = new Set<string>();
    const suggest = vi.fn(async (_db, _runId, input, options) => {
      if (options?.decisionModel !== "typesafe/jev") {
        pairedTargets.add(input.entityId!);
        throw new Error("paired model unavailable");
      }
      const target = input.targets[0]!;
      return fieldSuggestionsOut.parse({
        suggestions: {
          [target]: {
            value: category.shortcode,
            label: category.name,
            detail: null,
            confidence: "high",
            probability: 0.95,
            reasoning: "Synthetic primary decision",
            alternatives: [],
          },
        },
      });
    });
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        field: "categoryId",
        filters: { ids: products.map((p) => p.id) },
      },
      {
        context,
        decisionModel: () => "typesafe/jev",
        suggest,
        wait: async () => {},
      },
    );
    const rows = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, started.id));
    expect(pairedTargets.size).toBeGreaterThan(0);
    const pairedRecordIds = await Promise.all(
      [...pairedTargets].map((id) =>
        resolveLiveShortcode(ctx.db, id, "product"),
      ),
    );
    expect(
      rows.some(
        (row) =>
          pairedRecordIds.some((recordId) => recordId === row.recordId) &&
          row.kind === "addition" &&
          row.status === "applied",
      ),
    ).toBe(true);
  });

  it("reviews persisted suggestions through the entity update and records misses", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic review item",
        manufacturer: "Synthetic maker",
        categoryId: taxonomyId("tools"),
      }),
      ctx.actor,
    );
    const runId = (
      await startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          field: "categoryId",
          filters: { ids: [product.id] },
        },
        {
          context,
          decisionModel: () => "typesafe/jev",
          wait: async () => {},
          suggestPorts: {
            jev: vi.fn(highConfidence),
            registry: { "product.categoryId": categorySpec },
          },
        },
      )
    ).id;
    const pending = await listPendingSuggestions(ctx.db, {
      runId,
      minConfidence: 0,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("correction");
    const row = pending[0]!;

    await rejectSuggestion(ctx.db, context, { id: row.id });
    expect(
      await listPagePendingSuggestions(ctx.db, {
        entity: "product",
        recordIds: [row.recordId],
        fields: ["categoryId"],
      }),
    ).toHaveLength(0);
    const afterReject = await listPendingSuggestions(ctx.db, {
      runId,
      minConfidence: 0,
    });
    expect(afterReject).toHaveLength(0);
    const recordId = await resolveLiveShortcode(ctx.db, product.id, "product");
    if (!recordId) throw new Error("synthetic record setup failed");
    const [stillBlank] = await getDb(ctx.db)
      .select({ categoryId: productTable.categoryId })
      .from(productTable)
      .where(eq(productTable.id, recordId));
    expect(stillBlank?.categoryId).toBe(taxonomyId("tools"));
    expect(await summarizeSuggestionMisses(ctx.db, { runId })).toHaveLength(1);
  });

  it("accepts a persisted Suggestion through the entity kernel and marks it applied", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic accepted item",
        manufacturer: "Synthetic maker",
        categoryId: taxonomyId("tools"),
      }),
      ctx.actor,
    );
    const runId = (
      await startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          field: "categoryId",
          filters: { ids: [product.id] },
        },
        {
          context,
          decisionModel: () => "typesafe/jev",
          wait: async () => {},
          suggestPorts: {
            jev: vi.fn(highConfidence),
            registry: { "product.categoryId": categorySpec },
          },
        },
      )
    ).id;
    const [row] = await listPendingSuggestions(ctx.db, {
      runId,
      minConfidence: 0,
    });
    if (!row) throw new Error("synthetic suggestion setup failed");
    expect(
      await listPagePendingSuggestions(ctx.db, {
        entity: "product",
        recordIds: [row.recordId],
        fields: ["categoryId"],
      }),
    ).toEqual([expect.objectContaining({ id: row.id, model: "typesafe/jev" })]);
    await acceptSuggestion(ctx.db, context, { id: row.id });
    expect(
      await listPagePendingSuggestions(ctx.db, {
        entity: "product",
        recordIds: [row.recordId],
        fields: ["categoryId"],
      }),
    ).toHaveLength(0);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.id, row.id));
    const recordId = await resolveLiveShortcode(ctx.db, product.id, "product");
    if (!recordId) throw new Error("synthetic record setup failed");
    const [updated] = await getDb(ctx.db)
      .select({ categoryId: productTable.categoryId })
      .from(productTable)
      .where(eq(productTable.id, recordId));
    expect(saved?.status).toBe("applied");
    expect(updated?.categoryId).toBeTruthy();
  });

  it("accepts a reviewed value and groups Misses by field and suggested value", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic corrected item",
        manufacturer: "Synthetic maker",
        categoryId: taxonomyId("tools"),
      }),
      ctx.actor,
    );
    const secondProduct = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic corrected item two",
        manufacturer: "Synthetic maker",
        categoryId: taxonomyId("tools"),
      }),
      ctx.actor,
    );
    const runId = (
      await startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          field: "categoryId",
          filters: { ids: [product.id, secondProduct.id] },
        },
        {
          context,
          decisionModel: () => "typesafe/jev",
          wait: async () => {},
          suggestPorts: {
            jev: vi.fn(highConfidence),
            registry: { "product.categoryId": categorySpec },
          },
        },
      )
    ).id;
    const rows = await listPendingSuggestions(ctx.db, {
      runId,
      minConfidence: 0,
    });
    expect(rows).toHaveLength(2);
    for (const row of rows)
      await rejectSuggestion(ctx.db, context, {
        id: row.id,
        correctValue: taxonomyShortcode("food"),
      });
    const db = getDb(ctx.db);
    const recordId = await resolveLiveShortcode(ctx.db, product.id, "product");
    if (!recordId) throw new Error("synthetic record setup failed");
    const [updated] = await db
      .select({ categoryId: productTable.categoryId })
      .from(productTable)
      .where(eq(productTable.id, parseEntityId("product", recordId)));
    expect(updated?.categoryId).toBeTruthy();
    expect(await summarizeSuggestionMisses(ctx.db, { runId })).toMatchObject([
      { entity: "product", field: "categoryId", count: 2 },
    ]);
  });

  it("records a per-record dismissal as a Miss on its ai_suggest Run", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic dismissed item",
        manufacturer: "Synthetic maker",
        categoryId: taxonomyId("tools"),
      }),
      ctx.actor,
    );
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
    const [miss] = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, runId));
    expect(miss).toMatchObject({
      runId,
      entity: "product",
      field: "categoryId",
      status: "rejected",
      suggestedValue: taxonomyShortcode("food"),
    });
  });
});
