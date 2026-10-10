import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fieldSuggestionsOut } from "@cubby/schemas/ai";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { createProjectFromTasksInput } from "@cubby/schemas/project";
import { suggestionSweepRunProgress } from "@cubby/schemas/run-fields";
import { testShortcode } from "@cubby/schemas/testing";
import { and, eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
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
import { executeEntity } from "~/server/entity-kernel";
import { entityKernelContextSchema } from "~/server/entity-kernel/adapter";
import { projectCreateFromTasksWorkflow } from "~/server/operations/project.server";
import { getDb } from "~/server/repo/database-helpers";
import { updateExpensesInBulk } from "~/server/repo/expense/crud";
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
} from "~/server/repo/suggestion-review";
import { loadVendorSuggestionContext } from "~/server/repo/vendor-suggestion-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { aiCallRunInput, ensureRun } from "./ensure-run";
import {
  startSuggestionSweep as startSweep,
  resumeSuggestionSweep as resumeSweep,
  pauseSuggestionSweep,
} from "./suggestion-sweep";

const SUGGESTION_SWEEP_MIGRATION = readFileSync(
  join(import.meta.dirname, "../../../drizzle/0030_familiar_vargas.sql"),
  "utf8",
);

const noPairedSample = () => false;
const startSuggestionSweep = (
  db: Parameters<typeof startSweep>[0],
  input: Parameters<typeof startSweep>[1],
  ports: Parameters<typeof startSweep>[2],
) => startSweep(db, input, { samplePair: noPairedSample, ...ports });
const resumeSuggestionSweep = (
  db: Parameters<typeof resumeSweep>[0],
  runId: Parameters<typeof resumeSweep>[1],
  ports: Parameters<typeof resumeSweep>[2],
) => resumeSweep(db, runId, { samplePair: noPairedSample, ...ports });

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

  it("migrates legacy sweep input and checkpoints before resuming", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic legacy sweep target",
        manufacturer: "Synthetic maker",
        categoryId: taxonomyId("tools"),
      }),
      ctx.actor,
    );
    const productRecordId = await resolveLiveShortcode(
      ctx.db,
      product.id,
      "product",
    );
    if (!productRecordId)
      throw new Error("Synthetic product record is missing");
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "suggestion_sweep",
      trigger: "manual",
      status: "running",
      input: {
        kind: "suggestion_sweep",
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [product.id] },
        decisionModel: "typesafe/jev",
        paused: false,
      },
      progress: {
        total: 1,
        done: 1,
        applied: 0,
        queued: 1,
        failed: 0,
        diagnostics: [],
      },
    });
    await getDb(ctx.db).execute(sql`
      UPDATE "Run"
      SET input = input - 'fields' || jsonb_build_object('field', ${"categoryId"}::text),
          progress = progress || jsonb_build_object(
            'processedTargetIds', jsonb_build_array(${productRecordId}::uuid)
          )
      WHERE id = ${runId}
    `);
    await getDb(ctx.db).execute(sql.raw(SUGGESTION_SWEEP_MIGRATION));
    const [migrated] = await getDb(ctx.db)
      .select({ input: runTable.input, progress: runTable.progress })
      .from(runTable)
      .where(eq(runTable.id, runId));
    expect(migrated?.input).toMatchObject({ fields: ["categoryId"] });
    expect(migrated?.progress).toMatchObject({
      total: 1,
      done: 1,
      processedTargetIds: [`${productRecordId}:categoryId`],
    });
    const suggest = vi.fn(async () =>
      fieldSuggestionsOut.parse({ suggestions: {}, outcomes: {} }),
    );
    await resumeSuggestionSweep(ctx.db, runId, {
      context,
      suggest,
      wait: async () => {},
    });
    expect(suggest).not.toHaveBeenCalled();
  });

  it("supersedes pending Suggestions on raw entity writes used by imports", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic imported classification",
        manufacturer: "Synthetic maker",
        categoryId: taxonomyId("tools"),
      }),
      ctx.actor,
    );
    const productRecordId = await resolveLiveShortcode(
      ctx.db,
      product.id,
      "product",
    );
    if (!productRecordId)
      throw new Error("Synthetic product record is missing");
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "completed",
    });
    await getDb(ctx.db)
      .insert(suggestionTable)
      .values({
        runId,
        entity: "product",
        recordId: productRecordId,
        field: "categoryId",
        currentValue: taxonomyShortcode("tools"),
        suggestedValue: taxonomyShortcode("food"),
        confidence: 0.8,
        model: "typesafe/jev",
        kind: "correction",
        status: "pending",
      });
    await getDb(ctx.db).execute(sql`
      UPDATE "Product"
      SET "categoryId" = ${taxonomyId("food")}
      WHERE "id" = ${productRecordId}
    `);
    const [saved] = await getDb(ctx.db)
      .select({ status: suggestionTable.status })
      .from(suggestionTable)
      .where(eq(suggestionTable.recordId, productRecordId));
    expect(saved?.status).toBe("superseded");
  });

  it("leaves pending Suggestions alone when an entity column is unchanged", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic unchanged classification",
        manufacturer: "Synthetic maker",
        categoryId: taxonomyId("tools"),
      }),
      ctx.actor,
    );
    const recordId = await resolveLiveShortcode(ctx.db, product.id, "product");
    if (!recordId) throw new Error("Synthetic product record is missing");
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "completed",
    });
    const [row] = await getDb(ctx.db)
      .insert(suggestionTable)
      .values({
        runId,
        entity: "product",
        recordId,
        field: "categoryId",
        currentValue: taxonomyShortcode("tools"),
        suggestedValue: taxonomyShortcode("food"),
        confidence: 0.8,
        model: "typesafe/jev",
        kind: "correction",
        status: "pending",
      })
      .returning({ id: suggestionTable.id });
    await getDb(ctx.db).execute(sql`
      UPDATE "Product"
      SET "categoryId" = ${taxonomyId("tools")}
      WHERE "id" = ${recordId}
    `);
    const [saved] = await getDb(ctx.db)
      .select({ status: suggestionTable.status })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, row!.id));
    expect(saved?.status).toBe("pending");
  });

  it("supersedes pending Task project Suggestions on repository writes", async () => {
    const task = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "Synthetic task assignment",
    });
    const recordId = await resolveLiveShortcode(ctx.db, task.output.id, "task");
    if (!recordId) throw new Error("Synthetic task record is missing");
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "completed",
    });
    await getDb(ctx.db)
      .insert(suggestionTable)
      .values({
        runId,
        entity: "task",
        recordId,
        field: "projectId",
        currentValue: null,
        suggestedValue: testShortcode("project", "suggested-task-project"),
        confidence: 0.8,
        model: "typesafe/jev",
        kind: "addition",
        status: "pending",
      });
    await projectCreateFromTasksWorkflow(
      ctx.db,
      createProjectFromTasksInput.parse({
        taskIds: [task.output.id],
        project: { name: "Synthetic task project" },
      }),
      ctx.actor,
    );
    const [saved] = await getDb(ctx.db)
      .select({ status: suggestionTable.status })
      .from(suggestionTable)
      .where(eq(suggestionTable.recordId, recordId));
    expect(saved?.status).toBe("superseded");
  });

  it("supersedes a pending Suggestion in the repository bulk patch transaction", async () => {
    const expense = await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic bulk suggestion expense",
      cost: 10,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
    });
    const expenseRecordId = await resolveLiveShortcode(
      ctx.db,
      expense.shortcode,
      "expense",
    );
    if (!expenseRecordId)
      throw new Error("Synthetic expense record is missing");
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "completed",
    });
    await getDb(ctx.db).insert(suggestionTable).values({
      runId,
      entity: "expense",
      recordId: expenseRecordId,
      field: "projectId",
      currentValue: null,
      suggestedValue: "PRJ-2222",
      confidence: 0.8,
      model: "typesafe/jev",
      kind: "addition",
      status: "pending",
    });
    const project = await createRepoEntity(ctx, "project", {
      name: "Synthetic bulk assignment project",
    });
    await updateExpensesInBulk(
      ctx.db,
      [expense.shortcode],
      { projectId: project.output.id },
      ctx.actor,
    );
    const [saved] = await getDb(ctx.db)
      .select({ status: suggestionTable.status })
      .from(suggestionTable)
      .where(eq(suggestionTable.recordId, expenseRecordId));
    expect(saved?.status).toBe("superseded");
  });

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
        fields: ["spendingCategoryId"],
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
      decisionModel: () => "typesafe/jev" as const,
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
        fields: ["spendingCategoryId"],
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
        fields: ["defaultSpendingCategoryId"],
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
        fields: ["categoryId"],
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
        fields: ["categoryId"],
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
      fields: ["categoryId"],
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
          fields: ["categoryId"],
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
          fields: ["categoryId"],
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
    for (let index = 0; index < 1; index++) {
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
        { entity: "product", fields: ["categoryId"], filters: { ids } },
        {
          context: entityKernelContextSchema.parse(context),
          decisionModel: () => "typesafe/jev",
          samplePair: () => true,
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
    expect(pairedRows).toHaveLength(2);
    const reviewQueue = await listPendingSuggestions(ctx.db, {
      runId,
      minConfidence: 0,
    });
    expect(reviewQueue).toHaveLength(0);
    expect(
      await listPagePendingSuggestions(ctx.db, {
        entity: "product",
        recordIds: ids,
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
        "superseded",
      );
    }
  });

  it("filters pending pinned suggestions by kind and clears after a generic update", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const addition = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic suggestion addition",
        manufacturer: "Synthetic maker",
      }),
      ctx.actor,
    );
    const correction = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic suggestion correction",
        manufacturer: "Synthetic maker",
        categoryId: taxonomyId("tools"),
      }),
      ctx.actor,
    );
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [addition.id, correction.id] },
      },
      {
        context,
        decisionModel: () => "typesafe/jev",
        samplePair: () => true,
        wait: async () => {},
        suggestPorts: {
          jev: vi.fn(decisionAt(0.6)),
          registry: { "product.categoryId": categorySpec },
        },
      },
    );
    const additionRecordId = await resolveLiveShortcode(
      ctx.db,
      addition.id,
      "product",
    );
    if (!additionRecordId)
      throw new Error("synthetic addition did not resolve");
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
    const [unpinned] = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(
        and(
          eq(suggestionTable.runId, started.id),
          eq(
            suggestionTable.recordId,
            parseEntityId("product", additionRecordId),
          ),
          eq(suggestionTable.model, "@cf/cloudflare/clef"),
        ),
      );
    expect(unpinned?.status).toBe("pending");
    const [pinned] = await getDb(ctx.db)
      .select({ id: suggestionTable.id })
      .from(suggestionTable)
      .where(
        and(
          eq(suggestionTable.runId, started.id),
          eq(
            suggestionTable.recordId,
            parseEntityId("product", additionRecordId),
          ),
          eq(suggestionTable.model, "typesafe/jev"),
        ),
      );
    if (!pinned)
      throw new Error("synthetic pinned suggestion was not persisted");
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

  it("sweeps every target field only for rows selected by the list filters", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const matching = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic selected product",
        manufacturer: "Synthetic maker",
      }),
      ctx.actor,
    );
    await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic unselected product",
        manufacturer: "Other maker",
      }),
      ctx.actor,
    );
    const processed: Array<{ id: string; field: string }> = [];
    const suggest = vi.fn(async (_db, _runId, input) => {
      const field = input.targets[0]!;
      processed.push({ id: input.entityId!, field });
      return fieldSuggestionsOut.parse({
        suggestions: { [field]: null },
        outcomes: {
          [field]: {
            kind: "evaluated",
            answer: "none",
            confidence: "high",
            probability: 0.9,
            alternatives: [],
          },
        },
      });
    });
    const sweepInput = {
      entity: "product" as const,
      fields: ["categoryId", "tags"],
      filters: { manufacturerSearch: "Synthetic maker", ids: [matching.id] },
    };
    const ports = {
      context,
      decisionModel: () => "typesafe/jev" as const,
      samplePair: () => false,
      suggest,
      wait: async () => {},
    };
    const started = await startSuggestionSweep(ctx.db, sweepInput, {
      ...ports,
      pauseAfter: 1,
    });
    const paused = await getDb(ctx.db)
      .select({ progress: runTable.progress })
      .from(runTable)
      .where(eq(runTable.id, started.id));
    expect(suggestionSweepRunProgress.parse(paused[0]?.progress).done).toBe(1);
    await resumeSuggestionSweep(ctx.db, started.id, ports);
    expect(processed).toEqual([
      { id: matching.id, field: "categoryId" },
      { id: matching.id, field: "tags" },
    ]);
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
        fields: ["spendingCategoryId"],
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
        fields: ["defaultSpendingCategoryId"],
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
        fields: ["categoryId"],
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
      Array.from({ length: 2 }, (_, index) =>
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
        fields: ["categoryId"],
        filters: { ids: products.map((p) => p.id) },
      },
      {
        context,
        decisionModel: () => "typesafe/jev",
        samplePair: () => true,
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
          fields: ["categoryId"],
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
        recordIds: [product.id],
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
          fields: ["categoryId"],
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
        recordIds: [product.id],
        fields: ["categoryId"],
      }),
    ).toEqual([
      expect.objectContaining({
        id: row.id,
        model: "typesafe/jev",
        recordId: product.id,
      }),
    ]);
    const productRecordId = await resolveLiveShortcode(
      ctx.db,
      product.id,
      "product",
    );
    const [sibling] = await getDb(ctx.db)
      .insert(suggestionTable)
      .values({
        runId,
        entity: "product",
        recordId: productRecordId!,
        field: "categoryId",
        currentValue: taxonomyShortcode("tools"),
        suggestedValue: taxonomyShortcode("food"),
        confidence: 0.75,
        model: "typesafe/jev",
        kind: "correction",
        status: "pending",
      })
      .returning({ id: suggestionTable.id });
    await acceptSuggestion(ctx.db, context, { id: row.id });
    expect(
      await listPagePendingSuggestions(ctx.db, {
        entity: "product",
        recordIds: [product.id],
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
    const [savedSibling] = await getDb(ctx.db)
      .select({ status: suggestionTable.status })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, sibling!.id));
    expect(savedSibling?.status).toBe("superseded");
    expect(updated?.categoryId).toBeTruthy();
  });

  it("supersedes an earlier pending suggestion when a newer sweep evaluates the same field", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic repeated sweep item",
        manufacturer: "Synthetic maker",
        categoryId: taxonomyId("tools"),
      }),
      ctx.actor,
    );
    const ports = {
      context,
      decisionModel: () => "typesafe/jev" as const,
      wait: async () => {},
      suggestPorts: {
        jev: vi.fn(highConfidence),
        registry: { "product.categoryId": categorySpec },
      },
    };
    const input = {
      entity: "product" as const,
      fields: ["categoryId"],
      filters: { ids: [product.id] },
    };
    await startSuggestionSweep(ctx.db, input, ports);
    const [first] = await listPendingSuggestions(ctx.db, { minConfidence: 0 });
    expect(first).toBeDefined();
    await startSuggestionSweep(ctx.db, input, ports);
    const saved = await getDb(ctx.db)
      .select({ status: suggestionTable.status })
      .from(suggestionTable)
      .where(eq(suggestionTable.recordId, first!.recordId));
    expect(saved.map(({ status }) => status)).toEqual([
      "superseded",
      "pending",
    ]);
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
          fields: ["categoryId"],
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
    const rejected = await db
      .select({
        status: suggestionTable.status,
        correctValue: suggestionTable.correctValue,
      })
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, runId));
    expect(rejected).toHaveLength(2);
    expect(rejected.every((row) => row.status === "rejected")).toBe(true);
    expect(
      rejected.every((row) => row.correctValue === taxonomyShortcode("food")),
    ).toBe(true);
    const recordId = await resolveLiveShortcode(ctx.db, product.id, "product");
    if (!recordId) throw new Error("synthetic record setup failed");
    const [updated] = await db
      .select({ categoryId: productTable.categoryId })
      .from(productTable)
      .where(eq(productTable.id, parseEntityId("product", recordId)));
    expect(updated?.categoryId).toBeTruthy();
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
