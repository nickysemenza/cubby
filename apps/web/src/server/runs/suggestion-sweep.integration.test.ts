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
  run as runTable,
  suggestion as suggestionTable,
} from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel/adapter";
import { getDb } from "~/server/repo/database-helpers";
import { createProduct } from "~/server/repo/product/crud";
import { makeProductInput } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import {
  acceptSuggestion,
  listPendingSuggestions,
  rejectSuggestion,
  recordFieldSuggestionMiss,
  summarizeSuggestionMisses,
} from "~/server/repo/suggestion-review";
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
    await acceptSuggestion(ctx.db, context, { id: row.id });
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
