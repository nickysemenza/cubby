import { entityRefKey } from "@cubby/schemas/entity";
import { expenseCreateInput } from "@cubby/schemas/project";
import type { SearchableEntityRef } from "@cubby/schemas/search";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import type {
  EmbeddingRefreshPort,
  EmbeddingRefreshResult,
} from "~/server/background-tasks/embedding";
import { refreshEntityEmbeddings } from "~/server/background-tasks/embedding";
import { type getAiGateway, setCfEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getStoredEmbeddingHashes } from "~/server/repo/entity-embedding-refresh";
import { createExpense } from "~/server/repo/expense";
import {
  createProductFixture as createProduct,
  makeExpenseInput,
  makeProductInput,
  seedSearchDocumentsFixtureRaw,
  updateProductNameFixtureRaw,
} from "~/server/repo/repo.fixtures";
import {
  countUnembeddedSearchDocuments,
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
  selectUnembeddedSearchDocumentRefs,
} from "~/server/repo/search-document";
import { getActiveSuggestionDismissalKeys } from "~/server/repo/suggestion-dismissal";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import {
  createInMemoryVectorizeIndex,
  productionVectorStore,
  type VectorStorePort,
  vectorId,
} from "~/server/semantic/vector-store";
import { executeWorkflow } from "~/server/workflow-runtime";
import {
  getDuplicateProductRecommendationWorkflow,
  dismissDuplicateProductRecommendationWorkflow,
  dismissTagPropagationWorkflow,
  dismissProductRecommendationWorkflow,
} from "~/server/workflows/recommendations.server";
import {
  requestEmbeddingRefreshWorkflow,
  findSimilarEntitiesWorkflow,
} from "~/server/workflows/search.server";

import { countAwaitingWork, settleAwaitingWork } from "./awaiting-work.service";

/** Stand in for `env.AI.gateway("cubby")` (see `ai-gateway.unit.test.ts`). */
type AiGatewayBinding = NonNullable<ReturnType<typeof getAiGateway>>;

/** A vector store fake that records writes without needing a cf-env binding. */
const fakeVectorStore = (): VectorStorePort & {
  readonly vectors: Map<string, number[]>;
} => {
  const vectors = new Map<string, number[]>();
  return {
    vectors,
    configured: () => true,
    async upsert(items) {
      for (const item of items) vectors.set(vectorId(item), item.values);
    },
    async deleteByIds(refs) {
      for (const ref of refs) vectors.delete(vectorId(ref));
    },
    async query() {
      return [];
    },
    async queryById() {
      return [];
    },
  };
};

/** The provider is the one external seam: a deterministic fake vector per call. */
const fakeEmbeddingPort = (
  calls: string[][],
  vectorStore: VectorStorePort = fakeVectorStore(),
): EmbeddingRefreshPort => ({
  configured: () => true,
  config: getSemanticEmbeddingConfig,
  vectorStore,
  embed: async (texts) => {
    calls.push(texts);
    const { dimensions } = getSemanticEmbeddingConfig();
    return texts.map((_, index) =>
      Array.from({ length: dimensions }, (__, i) => (i === index ? 1 : 0)),
    );
  },
});

/**
 * Single-ref adapter over the batch API: calls `refreshEntityEmbeddings`
 * with a one-element batch and reads that ref's entry back by
 * `entityRefKey`, the same way a real caller (e.g. `handle.ts`) reads its
 * own refs out of the returned map.
 */
const refreshOne = (
  db: Database,
  ref: SearchableEntityRef,
  port: EmbeddingRefreshPort,
): Promise<EmbeddingRefreshResult | undefined> =>
  refreshEntityEmbeddings(db, [ref], port).then((results) =>
    results.get(entityRefKey(ref.entityType, ref.entityId)),
  );

describe("semantic search background tasks", () => {
  const ctx = withTestDb();

  afterEach(() => setCfEnv(undefined));

  it("keeps unavailable similarity results public and skips candidate work", async () => {
    const source = await createProduct(
      ctx.db,
      makeProductInput({ name: "Unembedded source" }),
      ctx.actor,
    );
    const started: string[] = [];
    const result = await executeWorkflow(
      findSimilarEntitiesWorkflow.definition,
      {
        context: ctx.db,
        input: { pair: "product_to_product", sourceId: source.id, limit: 5 },
        observer: (event) => {
          if (event.state === "started") started.push(event.step);
        },
      },
    );
    expect(result.source).toEqual({
      entityType: "product",
      entityId: source.id,
    });
    expect(result.status).not.toBe("ready");
    expect(result.results).toEqual([]);
    expect(started).toContain("readiness");
    expect(started).not.toContain("candidates");
    expect(started).not.toContain("hits");
    expect(JSON.stringify(result)).not.toContain(source.entityId);
  });

  it("resolves a public entity and publishes exactly its requested refresh", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Refresh test kettle" }),
      ctx.actor,
    );
    const published: unknown[] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (messages: Iterable<{ body: unknown }>) => {
            published.push(...[...messages].map((m) => m.body));
          },
        },
      }),
    );
    const result = await requestEmbeddingRefreshWorkflow(ctx.db, {
      entityType: "product",
      entityId: product.id,
    });
    expect(result).toEqual({ accepted: true });
    expect(published).toEqual([
      expect.objectContaining({
        version: 2,
        queueType: "background",
        task: expect.objectContaining({
          kind: "entity-embedding.refresh",
          entityType: "product",
          entityId: product.entityId,
        }),
      }),
    ]);
  });

  it("dismisses a current duplicate group and suppresses its recommendation", async () => {
    const source = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Duplicate identity one",
        manufacturer: "Example Fixtures",
        model: "MODEL-REF",
        externalIds: [
          { source: "example-one", kind: "retailer_sku", externalId: "DUP-1" },
        ],
      }),
      ctx.actor,
    );
    await createProduct(
      ctx.db,
      makeProductInput({
        name: "Duplicate identity two",
        manufacturer: "Example Fixtures",
        model: "MODEL-REF",
        externalIds: [
          { source: "example-two", kind: "retailer_sku", externalId: "DUP-2" },
        ],
      }),
      ctx.actor,
    );
    expect(
      await getDuplicateProductRecommendationWorkflow(ctx.db, {
        sourceId: source.id,
      }),
    ).not.toBeNull();
    expect(
      await dismissDuplicateProductRecommendationWorkflow(ctx.db, {
        sourceId: source.id,
      }),
    ).toEqual({ ok: true });
    expect(
      await getDuplicateProductRecommendationWorkflow(ctx.db, {
        sourceId: source.id,
      }),
    ).toBeNull();
    const keys = await getActiveSuggestionDismissalKeys(ctx.db, {
      sourceEntityType: "product",
      sourceEntityId: source.entityId,
      suggestionKind: "product.duplicate",
    });
    expect(keys.size).toBe(1);
  });

  it("rejects stale recommendation dismissals without storing them", async () => {
    const source = await createProduct(
      ctx.db,
      makeProductInput({ name: "Unrelated source" }),
      ctx.actor,
    );
    const target = await createProduct(
      ctx.db,
      makeProductInput({ name: "Unrelated target" }),
      ctx.actor,
    );
    await expect(
      dismissDuplicateProductRecommendationWorkflow(ctx.db, {
        sourceId: source.id,
      }),
    ).rejects.toThrow("Duplicate recommendation is no longer current");
    await expect(
      dismissTagPropagationWorkflow(ctx.db, {
        sourceId: source.id,
        tag: "collection:unproposed",
      }),
    ).rejects.toThrow("Tag recommendation is no longer current");
    await expect(
      dismissProductRecommendationWorkflow(ctx.db, {
        sourceId: source.id,
        targetId: target.id,
      }),
    ).rejects.toThrow("Recommendation is no longer current");
    for (const suggestionKind of [
      "product.duplicate",
      "product.tag-propagation",
      "product.related",
    ]) {
      const keys = await getActiveSuggestionDismissalKeys(ctx.db, {
        sourceEntityType: "product",
        sourceEntityId: source.entityId,
        suggestionKind,
      });
      expect(keys.size).toBe(0);
    }
  });

  it("embeds a fresh projection once, then skips it as fresh", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Backfill blue tarp" }),
      ctx.actor,
    );
    const calls: string[][] = [];
    const port = fakeEmbeddingPort(calls);
    const ref = { entityType: "product" as const, entityId: product.entityId };

    await expect(refreshOne(ctx.db, ref, port)).resolves.toEqual({
      outcome: "written",
    });
    // Duplicate or out-of-order delivery: the stored hash gates the provider.
    await expect(refreshOne(ctx.db, ref, port)).resolves.toEqual({
      outcome: "fresh",
    });
    expect(calls).toHaveLength(1);
    expect(
      await countUnembeddedSearchDocuments(
        ctx.db,
        getSemanticEmbeddingConfig(),
      ),
    ).toBe(0);
  });

  it("never writes a vector computed for text that has since changed", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Embedding before concurrent change" }),
      ctx.actor,
    );
    const ref = { entityType: "product" as const, entityId: product.entityId };
    const config = getSemanticEmbeddingConfig();
    const vectorFor = (marker: number) =>
      Array.from({ length: config.dimensions }, () => marker);

    // Two writers share one vector store, the way production shares one
    // Vectorize index — this is what lets writer A's stale upsert actually
    // clobber writer B's fresher one below. `productionVectorStore` reads the
    // binding through cf-env, so both ports below resolve to this same index.
    const index = createInMemoryVectorizeIndex();
    setCfEnv(fromPartial<Env>({ VECTORIZE: index }));
    const sharedVectorStore = productionVectorStore;

    // Writer B: a second, independent refresh call that runs to completion
    // (new text, new vector, new row) while writer A's provider call for the
    // OLD text is still in flight — see `writerAPort.embed` below.
    const writerBPort: EmbeddingRefreshPort = {
      configured: () => true,
      config: getSemanticEmbeddingConfig,
      vectorStore: sharedVectorStore,
      embed: async (texts) => texts.map(() => vectorFor(0.9)),
    };

    let racedOnce = false;
    const writerAPort: EmbeddingRefreshPort = {
      configured: () => true,
      config: getSemanticEmbeddingConfig,
      vectorStore: sharedVectorStore,
      // The provider call is where the race lives: writer B fully completes
      // its own refresh — text, vector, AND row — while writer A's slow call
      // for the pre-change text is still in flight. A's own vector (0.1,
      // below) would clobber B's (0.9) in the shared store if A did not
      // retry after its "obsolete" write.
      embed: async (texts) => {
        if (!racedOnce) {
          racedOnce = true;
          await updateProductNameFixtureRaw(
            ctx.db,
            product.entityId,
            "Embedding after concurrent change",
          );
          await refreshSearchDocument(ctx.db, "product", product.entityId);
          await refreshEntityEmbeddings(ctx.db, [ref], writerBPort);
          return texts.map(() => vectorFor(0.1));
        }
        // A's retry, now embedding the current (v2) text B already wrote.
        return texts.map(() => vectorFor(0.9));
      },
    };

    // A's own call self-heals: its first (pre-change) attempt is clobbered
    // onto an "obsolete" PG write (the guard rejects it, since the live
    // SearchDocument text moved on under it), but the bounded retry re-embeds
    // the now-current text and lands both the vector and the row — repairing
    // A's own clobber of B's vector rather than leaving the store behind
    // Postgres.
    await expect(refreshOne(ctx.db, ref, writerAPort)).resolves.toEqual({
      outcome: "written",
    });

    const currentText = await getSearchDocumentEmbeddingText(
      ctx.db,
      "product",
      product.entityId,
    );
    expect(currentText?.embeddingText).toContain(
      "Embedding after concurrent change",
    );
    expect(await countUnembeddedSearchDocuments(ctx.db, config)).toBe(0);
    // The store holds a vector for v2, never A's stale v1 clobber.
    expect(index.vectors.get(vectorId(ref))?.values).toEqual(vectorFor(0.9));
  });

  it("vector upsert throws: no EntityEmbedding hash row is written, and the error propagates", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Vector store outage" }),
      ctx.actor,
    );
    const ref = { entityType: "product" as const, entityId: product.entityId };
    const config = getSemanticEmbeddingConfig();
    const throwingVectorStore: VectorStorePort = {
      configured: () => true,
      upsert: async () => {
        throw new Error("vectorize outage");
      },
      deleteByIds: async () => {},
      query: async () => [],
      queryById: async () => [],
    };
    const port: EmbeddingRefreshPort = {
      configured: () => true,
      config: getSemanticEmbeddingConfig,
      vectorStore: throwingVectorStore,
      embed: async (texts) =>
        texts.map(() => Array(config.dimensions).fill(0.5)),
    };

    // A vector-store failure is reported per ref rather than thrown out of
    // `refreshEntityEmbeddings` — the queue consumer (`consume.ts`) reads
    // `{ error, throttled }` off the returned map and retries from there,
    // rather than recording a "written" row for a vector that was never
    // stored.
    const result = await refreshOne(ctx.db, ref, port);
    expect(result).toEqual({
      error: expect.objectContaining({ message: "vectorize outage" }),
      throttled: false,
    });

    const stored = await getStoredEmbeddingHashes(ctx.db, [ref], config);
    expect(
      stored.get(entityRefKey(ref.entityType, ref.entityId)),
    ).toBeUndefined();
  });

  // Regression: batching is the point of partitioning the queue by wave —
  // one embed call and one Vectorize upsert per refresh, not one pair per
  // ref, and a duplicate ref within the wave (queue redelivery, or two
  // requests racing for the same entity) must not double that cost.
  it("batches a whole refresh wave into one embed call and one vector upsert", async () => {
    const products = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        createProduct(
          ctx.db,
          makeProductInput({ name: `Batch product ${index}` }),
          ctx.actor,
        ),
      ),
    );
    const refs: SearchableEntityRef[] = products.map((product) => ({
      entityType: "product",
      entityId: product.entityId,
    }));
    const [duplicateRef] = refs;
    expect(duplicateRef).toBeDefined();
    const refsWithDuplicate = duplicateRef ? [...refs, duplicateRef] : refs;
    expect(refsWithDuplicate).toHaveLength(11);

    const calls: string[][] = [];
    const upsertCalls: unknown[][] = [];
    const vectorStore: VectorStorePort = {
      configured: () => true,
      upsert: async (items) => {
        upsertCalls.push([...items]);
      },
      deleteByIds: async () => {},
      query: async () => [],
      queryById: async () => [],
    };
    const port = fakeEmbeddingPort(calls, vectorStore);

    const results = await refreshEntityEmbeddings(
      ctx.db,
      refsWithDuplicate,
      port,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(10);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toHaveLength(10);
    expect(results.size).toBe(10);
    for (const ref of refs) {
      expect(results.get(entityRefKey(ref.entityType, ref.entityId))).toEqual({
        outcome: "written",
      });
    }
  });

  it("pages the unembedded selection with a keyset cursor", async () => {
    const pageSize = 250;
    await seedSearchDocumentsFixtureRaw(ctx.db, "product", pageSize + 5);
    const config = getSemanticEmbeddingConfig();
    expect(await countUnembeddedSearchDocuments(ctx.db, config)).toBe(
      pageSize + 5,
    );
    const first = await selectUnembeddedSearchDocumentRefs(ctx.db, config);
    expect(first.refs).toHaveLength(pageSize);
    expect(first.nextCursor).not.toBeNull();
    const second = await selectUnembeddedSearchDocumentRefs(ctx.db, config, {
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.refs).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const seen = new Set(
      [...first.refs, ...second.refs].map((ref) => ref.entityId),
    );
    expect(seen.size).toBe(pageSize + 5);
  });

  it("settle now republishes exactly what the awaiting counts describe", async () => {
    await seedSearchDocumentsFixtureRaw(ctx.db, "product", 3);
    // A financial entity with no EntityEmbedding row: searchable but not
    // embeddable, so `countAwaitingWork`/`settleAwaitingWork` must never
    // count or publish a refresh for it (see `unembeddedDocumentsSql`'s
    // `embeddableEntityTypesSql` filter).
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({ name: "Example unembeddable expense" }),
      ),
      ctx.actor,
    );
    const published: Array<{ task: { kind: string } }> = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: { task: { kind: string } } }>,
          ) => {
            published.push(...[...messages].map((m) => m.body));
          },
        },
        // countAwaitingWork now gates the count on semanticEmbeddingsConfigured(),
        // which needs both a reachable gateway (the AI binding stands in for
        // AI_GATEWAY_API_KEY, unset under vitest) and a configured vector store.
        AI: {
          gateway: () => fromPartial<AiGatewayBinding>({ run: () => {} }),
        },
        VECTORIZE: createInMemoryVectorizeIndex(),
      }),
    );
    const before = await countAwaitingWork(ctx.db);
    expect(before.unembeddedEntities).toBe(3);

    const settled = await settleAwaitingWork(ctx.db);
    expect(settled).toMatchObject({
      publishedEmbeddingTasks: 3,
      publishedRecipeTasks: 0,
      transport: "queue",
    });
    const embeddingTasks = published.filter(
      (m) => m.task.kind === "entity-embedding.refresh",
    );
    expect(embeddingTasks).toHaveLength(3);
  });

  it("unembeddedEntities is 0 when semantic embeddings are unconfigured", async () => {
    await seedSearchDocumentsFixtureRaw(ctx.db, "product", 2);
    // No setCfEnv call: no VECTORIZE binding, so semanticEmbeddingsConfigured()
    // is false and the count must degrade to 0 rather than report an
    // unfixable backlog (mirrors problems.service.ts countMissingEmbeddings).
    const result = await countAwaitingWork(ctx.db);
    expect(result.unembeddedEntities).toBe(0);
  });
});
