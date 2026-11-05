import { workQueueInput } from "@cubby/schemas/work-queue";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import {
  aiEvaluationItem,
  drainAiEvaluations,
} from "~/server/ai/evaluation/service/ai-evaluation-drain.fixtures";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { setCfEnv } from "~/server/cf-env";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  aiEvaluation,
  suggestionTable,
  entityLink,
  vendor as vendorTable,
  run,
  expense,
  searchDocument,
  product,
} from "~/server/db/schema";
import { publishPreparedEntityConnections } from "~/server/domains/connection/repo/entity-connections";
import {
  prepareConnectionFieldGuard,
  type ConnectionFieldGuardTargets,
} from "~/server/domains/connection/repo/field-connections";
import { publishProductPairPublications } from "~/server/domains/product/repo/match/product-match-candidate";
import { inferFieldAssessments } from "~/server/domains/run/operations/ai.server";
import { scheduleConnectionRefresh } from "~/server/domains/run/repo/connection-refresh";
import type { AiEvaluationPorts } from "~/server/domains/run/service/ai-evaluation-execution";
import {
  kernelCtx,
  PRIMARY_MODEL,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { readWorkQueue } from "~/server/domains/work/service/work-queue-read";
import * as selectedRead from "~/server/entity-kernel/selected-read";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { seedEntityEmbedding } from "~/server/generic/embedding/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { createInMemoryVectorizeIndex } from "~/server/generic/embedding/service/semantic/vector-store";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
} from "~/server/generic/search/repo/search-document";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
  createProductIdentityFixture,
  createIngredientFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { controlWorkflowRun } from "~/server/workflows/runs/control";

import { readEntityConnections } from "../repo/entity-connections";
import { prepareEntityConnections } from "./entity-connections";

// Existing rollback scenarios deliberately put all units in one caller-owned
// transaction to verify that a publisher cannot escape its database capability.
async function prepareCombinedConnections(
  ...args: Parameters<typeof prepareEntityConnections>
) {
  const { connections, productPairs, publications } =
    await prepareEntityConnections(...args);
  return async (db: Parameters<(typeof publications)[number]>[0]) => {
    await publishPreparedEntityConnections(db, connections);
    if (productPairs.length)
      await withTransactionDatabase(db, (tx) =>
        publishProductPairPublications(tx, productPairs),
      );
    for (const publish of publications) await publish(db);
  };
}

// Failure modes: model preparation publishes before cancellation is checked;
// the field publisher escapes its caller's fenced transaction; a bespoke review
// key reopens the exact inference a member already graded Wrong inline.
describe("connection preparation and publication authority", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(async () => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    queue.restore();
  });
  async function fixture() {
    const name = "Synthetic publication fence wrench";
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", item.entityId);
    const task = await createRepoEntity(ctx, "task", {
      name,
      trade: "electrical",
      subjectProductId: null,
    });
    await drainDerivedRefreshFrontier(ctx.db);
    return {
      source: { entityKind: "task" as const, entityId: task.output.id },
      task,
      name,
      item,
    };
  }
  const chooseFirst: DecisionPort = async (input) => {
    const keys = Object.keys(input.questions.selection.criteria);
    const choice = keys[0];
    if (!choice) throw new Error("Synthetic Product option is missing");
    return {
      answers: {
        selection: {
          type: "choice",
          choice,
          confidence: 0.7,
          probabilities: Object.fromEntries(
            keys.map((key) => [
              key,
              key === choice ? 0.7 : 0.3 / Math.max(1, keys.length - 1),
            ]),
          ),
        },
      },
    };
  };

  it("keeps pending coverage on its ticket and attempts, then fails a fixed budget overflow with the raw error after three attempts, never publishing part of a source", async () => {
    const config = getSemanticEmbeddingConfig();
    const values = Array.from({ length: config.dimensions }, (_, axis) =>
      axis === 0 ? 1 : 0,
    );
    const index = createInMemoryVectorizeIndex();
    setCfEnv(
      fromPartial<Env & { CUBBY_TEST_AI_GATEWAY: { fetch: typeof fetch } }>({
        VECTORIZE: index,
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
        CUBBY_TEST_AI_GATEWAY: {
          fetch: async () =>
            Response.json({ data: [{ index: 0, embedding: values }] }),
        },
      }),
    );
    const target = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic Acme Driver",
        brandId: await findOrCreateVendor(ctx.db, "Acme"),
      }),
      ctx.actor,
    );
    const payment = await createRepoEntity(ctx, "expense", {
      name: "Synthetic Acme Driver",
      cost: 20,
      trade: "other",
      costType: "materials",
    });
    await refreshSearchDocument(ctx.db, "product", target.entityId);
    await refreshSearchDocument(ctx.db, "expense", payment.entityId);
    await drainDerivedRefreshFrontier(ctx.db);
    const source = {
      entityKind: "expense",
      entityId: payment.output.id,
    } satisfies Parameters<typeof scheduleConnectionRefresh>[1];
    await activateAiRefresh(ctx.db, "synthetic-incomplete-coverage", {
      enabled: true,
    });
    const { runId } = await scheduleConnectionRefresh(ctx.db, source);
    if (!runId) throw new Error("Synthetic incomplete evaluation missing");
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, runId));
    if (!evaluation) throw new Error("Synthetic incomplete target missing");
    const stateOfEvaluation = async () =>
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, evaluation.id))
      )[0];
    // The Product's search document has no embedding yet: owed upstream work.
    await drainAiEvaluations(
      ctx.db,
      [evaluation.id],
      { context: kernelCtx(ctx) },
      { pages: 1 },
    );
    expect((await stateOfEvaluation())?.state).toBe("queued");
    const waiting = await aiEvaluationItem(ctx.db, evaluation.id);
    expect(waiting).toMatchObject({
      attempts: 0,
      lastError: null,
      waitCause: "search_coverage",
    });
    expect(await readEntityConnections(ctx.db, source)).toEqual([]);

    // Upstream settles, but the fixed ANN budget holds no complete answer.
    const text = await getSearchDocumentEmbeddingText(
      ctx.db,
      "product",
      target.entityId,
    );
    if (!text) throw new Error("Synthetic Product search document missing");
    const embeddingId = await seedEntityEmbedding(ctx.db, {
      ...text,
      config,
      values,
    });
    const budget = [
      embeddingId,
      ...Array.from({ length: 99 }, () => crypto.randomUUID()),
    ];
    await index.upsert(
      budget.map((id) => ({ id, values, metadata: { entityType: "product" } })),
    );
    await drainAiEvaluations(
      ctx.db,
      [evaluation.id],
      { context: kernelCtx(ctx) },
      { pages: 1 },
    );
    expect((await stateOfEvaluation())?.state).toBe("queued");
    expect(await aiEvaluationItem(ctx.db, evaluation.id)).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining("exceeded its fixed candidate budget"),
      waitCause: null,
    });
    expect(await readEntityConnections(ctx.db, source)).toEqual([]);
    await drainAiEvaluations(
      ctx.db,
      [evaluation.id],
      { context: kernelCtx(ctx) },
      { pages: 2 },
    );
    expect(await stateOfEvaluation()).toMatchObject({
      state: "failed",
      error: expect.stringContaining("coverage is unconfirmed"),
    });
    expect(await aiEvaluationItem(ctx.db, evaluation.id)).toBeUndefined();
    expect(await readEntityConnections(ctx.db, source)).toEqual([]);
  });

  it("retries an unavailable field target alone after its healthy sibling publishes", async () => {
    const { source, task, name } = await fixture();
    const siblingTask = await createRepoEntity(ctx, "task", {
      name,
      trade: "electrical",
      subjectProductId: null,
    });
    const sibling = {
      entityKind: "task" as const,
      entityId: siblingTask.output.id,
    };
    await drainDerivedRefreshFrontier(ctx.db);
    await activateAiRefresh(ctx.db, "synthetic-unavailable-field", {
      enabled: true,
    });
    await scheduleConnectionRefresh(ctx.db, source);
    await scheduleConnectionRefresh(ctx.db, sibling);
    const evaluations = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.feature, "entity-connections"));
    const evaluationFor = (recordId: string) => {
      const found = evaluations.find((row) => row.target.recordId === recordId);
      if (!found) throw new Error("Synthetic connection evaluation is missing");
      return found.id;
    };
    const unavailableId = evaluationFor(task.entityId);
    const siblingId = evaluationFor(siblingTask.entityId);
    const settled = async (id: string) =>
      (
        await getDb(ctx.db)
          .select({ state: aiEvaluation.state, error: aiEvaluation.error })
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, id))
      )[0];
    const fieldAssessments = (recordId: typeof task.entityId) =>
      getDb(ctx.db)
        .select({ id: suggestionTable.id })
        .from(suggestionTable)
        .where(
          and(
            eq(suggestionTable.recordId, recordId),
            eq(suggestionTable.field, "subjectProductId"),
          ),
        );
    const read = selectedRead.readSelectedEntityRecords;
    vi.spyOn(selectedRead, "readSelectedEntityRecords").mockImplementation(
      async (input) => {
        const records = await read(input);
        // Only the publication guard reads this target field by itself.
        return input.ids[0] === source.entityId &&
          input.fields.length === 1 &&
          input.fields[0] === "subjectProductId"
          ? records.map((record) => ({
              ...record,
              fields: { subjectProductId: { result: { kind: "missing" } } },
            }))
          : records;
      },
    );
    const ports: AiEvaluationPorts = {
      context: kernelCtx(ctx),
      suggestPorts: {
        decisionModel: PRIMARY_MODEL,
        decisionPort: chooseFirst,
      },
    };

    expect(
      await drainAiEvaluations(ctx.db, [unavailableId, siblingId], ports, {
        pages: 1,
      }),
    ).toEqual(["succeeded"]);

    // The sibling's outcome committed and its item is gone, so no retry can buy
    // its answer again. The unavailable target stays owed with its own attempt.
    expect((await settled(siblingId))?.state).toBe("completed");
    expect(await aiEvaluationItem(ctx.db, siblingId)).toBeUndefined();
    expect(await fieldAssessments(siblingTask.entityId)).not.toEqual([]);
    expect((await settled(unavailableId))?.state).toBe("queued");
    expect(await aiEvaluationItem(ctx.db, unavailableId)).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining(
        "Suggestion target field result is unavailable",
      ),
    });
    expect(await fieldAssessments(task.entityId)).toEqual([]);

    await drainAiEvaluations(ctx.db, [unavailableId], ports, { pages: 2 });
    expect(await settled(unavailableId)).toMatchObject({
      state: "failed",
      error: expect.stringContaining(
        "Suggestion target field result is unavailable",
      ),
    });
    expect(await aiEvaluationItem(ctx.db, unavailableId)).toBeUndefined();
    expect(await fieldAssessments(task.entityId)).toEqual([]);
  });

  for (const change of ["cancel", "obsolete"] as const)
    it(`publishes no actionable Assessment when an in-flight attempt becomes ${change}`, async () => {
      const { source, task } = await fixture();
      const activation = await activateAiRefresh(
        ctx.db,
        "synthetic-connection-fence",
        { enabled: true },
      );
      const { runId } = await scheduleConnectionRefresh(ctx.db, source);
      if (!runId)
        throw new Error("Synthetic connection evaluation was not scheduled");
      const [evaluation] = await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.runId, runId));
      if (!evaluation)
        throw new Error("Synthetic connection evaluation is missing");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const execution = drainAiEvaluations(ctx.db, [evaluation.id], {
        context: kernelCtx(ctx),
        suggestPorts: {
          decisionModel: PRIMARY_MODEL,
          decisionPort: async (input) => {
            entered.resolve();
            await release.promise;
            return chooseFirst(input);
          },
        },
      });
      try {
        await Promise.race([
          entered.promise,
          execution.then(() => {
            throw new Error(
              "Connection evaluation ended before external inference",
            );
          }),
        ]);
        expect(
          await getDb(ctx.db)
            .select()
            .from(suggestionTable)
            .where(
              and(
                eq(suggestionTable.recordId, task.entityId),
                eq(suggestionTable.active, true),
                eq(suggestionTable.status, "pending"),
              ),
            ),
        ).toEqual([]);
        if (change === "cancel") {
          const [owner] = await getDb(ctx.db)
            .select()
            .from(run)
            .where(eq(run.id, runId));
          if (!owner) throw new Error("Synthetic connection Run is missing");
          await controlWorkflowRun(
            ctx.db,
            ctx.actor,
            { runPublicId: owner.shortcode, action: "cancel" },
            "ai_refresh",
          );
        } else {
          const feature = activation.manifest["entity-connections"];
          if (!feature)
            throw new Error(
              "Connection feature is absent from the active manifest",
            );
          await activateAiRefresh(ctx.db, "synthetic-obsolete-connection", {
            enabled: true,
            manifest: {
              ...activation.manifest,
              "entity-connections": {
                ...feature,
                promptVersion: "synthetic-next-connection-policy",
              },
            },
          });
        }
      } finally {
        release.resolve();
      }
      await execution;
      expect(
        await getDb(ctx.db)
          .select()
          .from(suggestionTable)
          .where(
            and(
              eq(suggestionTable.recordId, task.entityId),
              eq(suggestionTable.active, true),
              eq(suggestionTable.status, "pending"),
            ),
          ),
      ).toEqual([]);
      const [settled] = await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.id, evaluation.id));
      expect(settled?.state).not.toBe("completed");
    });

  it("refuses a field target changed while inference is pending even without a refreshed search projection", async () => {
    const { source, item, task } = await fixture();
    const fieldGuardTargets: ConnectionFieldGuardTargets = new Map();
    // Reused page evidence must retain the same live target fence.
    await prepareConnectionFieldGuard(
      ctx.db,
      source,
      "subjectProductId",
      fieldGuardTargets,
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const preparation = prepareCombinedConnections(
      ctx.db,
      kernelCtx(ctx),
      source,
      {
        fieldGuardTargets,
        suggestPorts: {
          decisionModel: PRIMARY_MODEL,
          decisionPort: async (input) => {
            entered.resolve();
            await release.promise;
            return chooseFirst(input);
          },
        },
      },
    );
    try {
      await Promise.race([
        entered.promise,
        preparation.then(() => {
          throw new Error("Preparation ended before field inference");
        }),
      ]);
      await getDb(ctx.db)
        .update(product)
        .set({ name: "Synthetic changed target identity" })
        .where(eq(product.id, item.entityId));
    } finally {
      release.resolve();
    }
    await expect(preparation).rejects.toThrow(
      /target changed during inference/i,
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(
          and(
            eq(suggestionTable.recordId, task.entityId),
            eq(suggestionTable.status, "pending"),
          ),
        ),
    ).toEqual([]);
  });

  it("refuses an acquisition candidate assigned to another Product while subsequent inference is pending", async () => {
    const item = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic basil powder",
        brandId: await findOrCreateVendor(ctx.db, "Synthetic pantry"),
      }),
      ctx.actor,
    );
    const other = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic unrelated socket",
        brandId: await findOrCreateVendor(ctx.db, "Synthetic hardware"),
      }),
      ctx.actor,
    );
    const ingredient = await createIngredientFixture(
      ctx.db,
      buildEntity("ingredient", { name: "Synthetic basil powder" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "ingredient", ingredient.entityId);
    const charge = await createRepoEntity(ctx, "expense", {
      name: "Synthetic basil powder",
      trade: "electrical",
      cost: 18,
      costType: "materials",
    });
    await refreshSearchDocument(ctx.db, "expense", charge.entityId);
    const [before] = await getDb(ctx.db)
      .select({ hash: searchDocument.sourceHash })
      .from(searchDocument)
      .where(eq(searchDocument.entityId, charge.entityId));
    if (!before)
      throw new Error("Synthetic expense search projection is missing");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const preparation = prepareCombinedConnections(
      ctx.db,
      kernelCtx(ctx),
      { entityKind: "product", entityId: item.id },
      {
        suggestPorts: {
          decisionModel: PRIMARY_MODEL,
          decisionPort: async (input) => {
            entered.resolve();
            await release.promise;
            return chooseFirst(input);
          },
        },
      },
    );
    try {
      await Promise.race([
        entered.promise,
        preparation.then(() => {
          throw new Error(
            "Connection preparation ended before external inference",
          );
        }),
      ]);
      // This real stored-value drift intentionally leaves SearchDocument unchanged.
      await getDb(ctx.db)
        .update(expense)
        .set({ productId: other.entityId })
        .where(eq(expense.id, charge.entityId));
      expect(
        (
          await getDb(ctx.db)
            .select({ hash: searchDocument.sourceHash })
            .from(searchDocument)
            .where(eq(searchDocument.entityId, charge.entityId))
        )[0],
      ).toEqual(before);
    } finally {
      release.resolve();
    }
    const publish = await preparation;
    await expect(withTransactionDatabase(ctx.db, publish)).rejects.toThrow(
      /evidence changed|no longer eligible|already assigned/i,
    );
    expect(
      (
        await getDb(ctx.db)
          .select({ productId: expense.productId })
          .from(expense)
          .where(eq(expense.id, charge.entityId))
      )[0]?.productId,
    ).toBe(other.entityId);
    expect(
      await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(
          and(
            eq(suggestionTable.family, "recommendation"),
            eq(suggestionTable.recordId, item.entityId),
            eq(suggestionTable.active, true),
            eq(suggestionTable.status, "pending"),
          ),
        ),
    ).toEqual([]);
  });

  // Regression: batching every stage's candidates captured retrieval-time
  // evidence only after the semantic scan's provider call returned, so a link
  // removed meanwhile was captured as current and the proposal still claimed it.
  it("captures retrieved identity-link evidence before a pending query embedding", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic pending embedding lamp" }),
      ctx.actor,
    );
    const vendor = await findOrCreateVendor(ctx.db, "Synthetic lamp vendor");
    const order = await createRepoEntity(ctx, "purchase", {
      vendorId: (
        await getDb(ctx.db)
          .select({ code: vendorTable.shortcode })
          .from(vendorTable)
          .where(eq(vendorTable.id, vendor))
      )[0]!.code,
      orderId: "SYNTHETIC-PENDING-EMBEDDING",
      defaultProjectId: null,
    });
    const [link] = await getDb(ctx.db)
      .insert(entityLink)
      .values({
        kind: "purchaseProduct",
        fromEntityId: order.entityId,
        fromKind: "purchase",
        toEntityId: item.entityId,
        toKind: "product",
      } as typeof entityLink.$inferInsert)
      .returning({ id: entityLink.id });
    const values = Array.from(
      { length: getSemanticEmbeddingConfig().dimensions },
      (_, axis) => (axis === 0 ? 1 : 0),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    setCfEnv(
      fromPartial<Env & { CUBBY_TEST_AI_GATEWAY: { fetch: typeof fetch } }>({
        VECTORIZE: createInMemoryVectorizeIndex(),
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
        CUBBY_TEST_AI_GATEWAY: {
          fetch: async () => {
            entered.resolve();
            await release.promise;
            return Response.json({ data: [{ index: 0, embedding: values }] });
          },
        },
      }),
    );
    const preparation = prepareCombinedConnections(ctx.db, kernelCtx(ctx), {
      entityKind: "product",
      entityId: item.id,
    });
    try {
      await Promise.race([
        entered.promise,
        preparation.then(() => {
          throw new Error("Connection preparation ended before the embedding");
        }),
      ]);
      await getDb(ctx.db)
        .update(entityLink)
        .set({ deletedAt: new Date() })
        .where(eq(entityLink.id, link!.id));
    } finally {
      release.resolve();
    }
    const publish = await preparation;
    await expect(withTransactionDatabase(ctx.db, publish)).rejects.toThrow(
      /evidence changed/i,
    );
  });

  it("rolls field publication back with the fenced caller transaction", async () => {
    const { source, task } = await fixture();
    const publish = await prepareCombinedConnections(
      ctx.db,
      kernelCtx(ctx),
      source,
      {
        suggestPorts: {
          decisionModel: PRIMARY_MODEL,
          decisionPort: chooseFirst,
        },
      },
    );
    await expect(
      withTransactionDatabase(ctx.db, async (transactionDb) => {
        await publish(transactionDb);
        expect(
          await getDb(transactionDb)
            .select()
            .from(suggestionTable)
            .where(
              and(
                eq(suggestionTable.recordId, task.entityId),
                eq(suggestionTable.field, "subjectProductId"),
                eq(suggestionTable.active, true),
                eq(suggestionTable.status, "pending"),
              ),
            ),
        ).toContainEqual(
          expect.objectContaining({
            field: "subjectProductId",
            status: "pending",
          }),
        );
        throw new Error("synthetic fenced rollback");
      }),
    ).rejects.toThrow("synthetic fenced rollback");
    expect(
      await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(
          and(
            eq(suggestionTable.recordId, task.entityId),
            eq(suggestionTable.active, true),
            eq(suggestionTable.status, "pending"),
          ),
        ),
    ).toEqual([]);
  });

  it("rejects stale field evidence on both connection and Work reads", async () => {
    const { source, item } = await fixture();
    const publish = await prepareCombinedConnections(
      ctx.db,
      kernelCtx(ctx),
      source,
      {
        suggestPorts: {
          decisionModel: PRIMARY_MODEL,
          decisionPort: chooseFirst,
        },
      },
    );
    await withTransactionDatabase(ctx.db, publish);
    expect(await readEntityConnections(ctx.db, source)).toContainEqual(
      expect.objectContaining({
        relation: "task-subject-product",
        integration: { kind: "field-review", field: "subjectProductId" },
      }),
    );
    // The suggested value names the target, so the Product reads it too.
    expect(
      await readEntityConnections(ctx.db, {
        entityKind: "product",
        entityId: item.id,
      }),
    ).toContainEqual(
      expect.objectContaining({
        relation: "task-subject-product",
        integration: { kind: "field-review", field: "subjectProductId" },
      }),
    );
    await drainDerivedRefreshFrontier(ctx.db);
    const before = await readWorkQueue(ctx.db, {
      input: workQueueInput.parse({ pageSize: 100 }),
      memberPartyId: null,
      memberOnly: false,
    });
    expect(before.items).toContainEqual(
      expect.objectContaining({
        reasonKeys: ["suggestions:field"],
      }),
    );
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic renamed target evidence" })
      .where(eq(product.id, item.entityId));
    // The record read rechecks evidence. Work lists pending rows without
    // revalidating them, so the row may stay queued until it is opened.
    expect(await readEntityConnections(ctx.db, source)).toEqual([]);
  });

  it("withholds the same served field evidence after inline Wrong Feedback", async () => {
    const { source, task, name } = await fixture();
    const context = kernelCtx(ctx);
    const suggestPorts = {
      decisionModel: PRIMARY_MODEL,
      decisionPort: chooseFirst,
    };
    const inline = await inferFieldAssessments(
      context,
      {
        entity: "task",
        entityId: source.entityId,
        targets: ["subjectProductId"],
        basisMode: "provided",
        basis: { name, subjectProductId: null },
        decisionModel: PRIMARY_MODEL,
      },
      suggestPorts,
    );
    const id = inline.suggestions.subjectProductId?.assessmentId;
    if (!id) throw new Error("Synthetic inline field Assessment is missing");
    await reviewAssessment(ctx.db, context, {
      assessmentId: id,
      operationId: "synthetic-inline-wrong",
      verdict: "wrong",
      intent: "history",
    });
    const publish = await prepareCombinedConnections(ctx.db, context, source, {
      suggestPorts,
    });
    await publish(ctx.db);
    expect(
      await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(
          and(
            eq(suggestionTable.recordId, task.entityId),
            eq(suggestionTable.field, "subjectProductId"),
            eq(suggestionTable.active, true),
            eq(suggestionTable.status, "pending"),
          ),
        ),
    ).toEqual([]);
  });
});
