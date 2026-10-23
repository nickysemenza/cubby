import { entityRefKey } from "@cubby/schemas/entity";
import type { SearchableEntityRef } from "@cubby/schemas/search";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, isNull } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { type getAiGateway, setCfEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { entityEmbedding, job } from "~/server/db/schema";
import { countUnembeddedEntities } from "~/server/domains/maintenance/service/maintenance.service";
import { productPairFingerprint } from "~/server/domains/product/repo/match/product-identity-snapshot";
import { publishProductPair } from "~/server/domains/product/repo/match/product-match-candidate";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { getActiveAssessmentSuppressionKeys } from "~/server/generic/assessment/repo/assessment-state";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";
import { getStoredEmbeddingHashes } from "~/server/generic/embedding/repo/entity-embedding-refresh";
import { findSimilarEntitiesWorkflow } from "~/server/generic/embedding/service/semantic-similarity";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  createInMemoryVectorizeIndex,
  productionVectorStore,
  type VectorStorePort,
} from "~/server/generic/embedding/service/semantic/vector-store";
import { requestEmbeddingRefreshWorkflow } from "~/server/generic/search/operations/search.server";
import {
  countUnembeddedSearchDocuments,
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
  prepareSearchDocuments,
  selectUnembeddedSearchDocumentRefs,
} from "~/server/generic/search/repo/search-document";
import {
  createProductFixture as createProduct,
  makeExpenseInput,
  makeProductInput,
  seedSearchDocumentsFixtureRaw,
  renameFixtureRaw,
} from "~/server/testing/repo.fixtures";
import type { EmbeddingRefreshPort } from "~/server/workflows/background-tasks/embedding";
import { enqueueEmbeddingRefs } from "~/server/workflows/background-tasks/embedding";
import { executeWorkflow } from "~/server/workflows/runtime";

import {
  advanceEmbeddingFixture,
  embedFixtures,
} from "../repo/embedding-job.fixtures";

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
      for (const item of items) vectors.set(item.id, item.values);
      return new Map(items.map((item) => [item.id, crypto.randomUUID()]));
    },
    async deleteByIds(refs) {
      for (const ref of refs) vectors.delete(ref);
      return new Map(refs.map((id) => [id, crypto.randomUUID()]));
    },
    async query() {
      return [];
    },
    async queryById(id) {
      return vectors.has(id)
        ? [...vectors.keys()].map((id) => ({ id, similarity: 1 }))
        : [];
    },
    async getByIds(ids) {
      return ids.flatMap((id) => {
        const values = vectors.get(id);
        return values ? [{ id, values }] : [];
      });
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

/** Exercise the real claim, upload checkpoint and selection publication. */
const refreshOne = async (
  db: Database,
  ref: SearchableEntityRef,
  port: EmbeddingRefreshPort,
) => {
  const [saved] = await enqueueEmbeddingRefs(
    db,
    await prepareSearchDocuments(db, [ref]),
    port.config(),
  );
  if (!saved) throw new Error("Missing synthetic embedding Job");
  await advanceEmbeddingFixture(db, saved.id, port);
  return advanceEmbeddingFixture(db, saved.id, port);
};

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
      entityKind: "product",
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
      entityKind: "product",
      entityId: product.id,
    });
    expect(result).toEqual({ accepted: true });
    expect(published).toEqual([
      expect.objectContaining({
        version: 3,
        queueType: "background",
      }),
    ]);
    const jobs = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.kind, "embedding.refresh"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.input).toMatchObject({
      entityKind: "product",
      entityId: product.entityId,
    });
  });

  it("dismisses a current duplicate group and suppresses its recommendation", async () => {
    const source = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Duplicate identity one",
        brandId: await findOrCreateVendor(ctx.db, "Example Fixtures"),
        model: "MODEL-REF",
        externalIds: [
          { source: "example-one", kind: "retailer_sku", externalId: "DUP-1" },
        ],
      }),
      ctx.actor,
    );
    const duplicate = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Duplicate identity two",
        brandId: await findOrCreateVendor(ctx.db, "Example Fixtures"),
        model: "MODEL-REF",
        externalIds: [
          { source: "example-two", kind: "retailer_sku", externalId: "DUP-2" },
        ],
      }),
      ctx.actor,
    );
    await publishProductPair(ctx.db, {
      productIds: [source.entityId, duplicate.entityId],
      fingerprint: await productPairFingerprint(ctx.db, [
        source.entityId,
        duplicate.entityId,
      ]),
      source: "detector",
      actionable: true,
      evidence: "Synthetic retained exact identity",
      sourceUrls: [],
    });
    const [recommendation] = (
      await listSuggestionPage(ctx.db, {
        family: "product_pair",
        recordIds: [source.id],
      })
    ).items;
    if (!recommendation?.review?.suppression)
      throw new Error("Synthetic pair review missing");
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: recommendation.assessmentId,
      expectedFingerprint: recommendation.fingerprint,
      suppression: recommendation.review.suppression,
      operationId: crypto.randomUUID(),
      verdict: "dismissed",
      intent: "history",
    });
    await publishProductPair(ctx.db, {
      productIds: [source.entityId, duplicate.entityId],
      fingerprint: await productPairFingerprint(ctx.db, [
        source.entityId,
        duplicate.entityId,
      ]),
      source: "detector",
      actionable: true,
      evidence: "Synthetic retained exact identity",
      sourceUrls: [],
    });
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "product_pair",
          recordIds: [source.id],
        })
      ).items,
    ).toEqual([]);
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
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "product_pair",
          recordIds: [source.id],
        })
      ).items,
    ).toEqual([]);
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        verdict: "dismissed",
        intent: "history",
        suppression: {
          scope: "product.related",
          candidateKey: target.id,
          fingerprint: null,
        },
      }),
    ).rejects.toThrow("Assessment not found");
    for (const suggestionKind of [
      "product.duplicate",
      "product.tag-propagation",
      "product.related",
    ]) {
      const keys = await getActiveAssessmentSuppressionKeys(ctx.db, {
        entityKind: "product",
        entityId: source.entityId,
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
    const ref = { entityKind: "product" as const, entityId: product.entityId };

    const first = await refreshOne(ctx.db, ref, port);
    expect(first).toMatchObject({
      state: "completed",
      result: { outcome: "written" },
    });
    // Duplicate or out-of-order delivery: the stored hash gates the provider.
    const duplicate = await refreshOne(ctx.db, ref, port);
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.state).toBe("completed");
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
    const ref = { entityKind: "product" as const, entityId: product.entityId };
    const config = getSemanticEmbeddingConfig();
    const vectorFor = (marker: number) =>
      Array.from({ length: config.dimensions }, () => marker);

    // Both writers share the remote index; their physical identities must remain distinct.
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
      // Writer B publishes the new input while A's provider is still in flight.
      embed: async (texts) => {
        if (!racedOnce) {
          racedOnce = true;
          await renameFixtureRaw(
            ctx.db,
            "product",
            product.entityId,
            "Embedding after concurrent change",
          );
          await refreshSearchDocument(ctx.db, "product", product.entityId);
          await embedFixtures(ctx.db, [ref], writerBPort);
          return texts.map(() => vectorFor(0.1));
        }
        return texts.map(() => vectorFor(0.9));
      },
    };

    expect(await refreshOne(ctx.db, ref, writerAPort)).toMatchObject({
      state: "cancelled",
      error: "Embedding source superseded",
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
    const [selected] = await getDb(ctx.db)
      .select({ id: entityEmbedding.id })
      .from(entityEmbedding)
      .where(
        and(
          eq(entityEmbedding.entityId, ref.entityId),
          eq(entityEmbedding.artifactState, "selected"),
          isNull(entityEmbedding.deletedAt),
        ),
      );
    expect(selected).toBeDefined();
    expect(selected ? index.vectors.get(selected.id)?.values : null).toEqual(
      vectorFor(0.9),
    );
  });

  it("vector upsert throws: no EntityEmbedding hash row is written, and the error propagates", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Vector store outage" }),
      ctx.actor,
    );
    const ref = { entityKind: "product" as const, entityId: product.entityId };
    const config = getSemanticEmbeddingConfig();
    const throwingVectorStore: VectorStorePort = {
      configured: () => true,
      upsert: async () => {
        throw new Error("vectorize outage");
      },
      deleteByIds: async () => new Map(),
      getByIds: async () => [],
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

    const result = await refreshOne(ctx.db, ref, port);
    expect(result.state).toBe("retry_wait");
    expect(result.error).toContain("vectorize outage");

    const stored = await getStoredEmbeddingHashes(ctx.db, [ref], config);
    expect(
      stored.get(entityRefKey(ref.entityKind, ref.entityId)),
    ).toBeUndefined();
  });

  // Repeated admission cannot create a second paid execution for a content key.
  it("coalesces duplicate refs into immutable Job execution", async () => {
    const products = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        createProduct(
          ctx.db,
          makeProductInput({ name: `Synthetic batch product ${index}` }),
          ctx.actor,
        ),
      ),
    );
    const refs: SearchableEntityRef[] = products.map((product) => ({
      entityKind: "product",
      entityId: product.entityId,
    }));
    const first = refs[0];
    if (!first) throw new Error("Missing synthetic ref");
    const calls: string[][] = [];
    const port = fakeEmbeddingPort(calls);
    const saved = await embedFixtures(ctx.db, [...refs, first], port);
    expect(new Set(saved.map((execution) => execution.id)).size).toBe(10);
    expect(calls).toHaveLength(10);
    expect(await countUnembeddedSearchDocuments(ctx.db, port.config())).toBe(0);
    await embedFixtures(ctx.db, refs, port);
    expect(calls).toHaveLength(10);
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

  it("the maintenance embeddings backlog counts only embeddable documents", async () => {
    await seedSearchDocumentsFixtureRaw(ctx.db, "product", 3);
    // A financial entity with no EntityEmbedding row: searchable but not
    // embeddable, so the maintenance embeddings step must never count or
    // refresh it (see `unembeddedDocumentsSql`'s `embeddableEntityKindsSql`
    // filter, which both the count and the step's page selection share).
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({ name: "Example unembeddable expense" }),
    );
    setCfEnv(
      fromPartial<Env>({
        // The backlog count gates on semanticEmbeddingsConfigured(),
        // which needs both a reachable gateway (the AI binding stands in for
        // AI_GATEWAY_API_KEY, unset under vitest) and a configured vector store.
        AI: {
          gateway: () => fromPartial<AiGatewayBinding>({ run: () => {} }),
        },
        VECTORIZE: createInMemoryVectorizeIndex(),
      }),
    );
    expect(await countUnembeddedEntities(ctx.db)).toBe(3);
    const page = await selectUnembeddedSearchDocumentRefs(
      ctx.db,
      getSemanticEmbeddingConfig(),
    );
    expect(page.refs.map((ref) => ref.entityKind)).toEqual([
      "product",
      "product",
      "product",
    ]);
  });

  it("unembeddedEntities is 0 when semantic embeddings are unconfigured", async () => {
    await seedSearchDocumentsFixtureRaw(ctx.db, "product", 2);
    // No setCfEnv call: no VECTORIZE binding, so semanticEmbeddingsConfigured()
    // is false and the count must degrade to 0 rather than report an
    // unfixable backlog.
    expect(await countUnembeddedEntities(ctx.db)).toBe(0);
  });
});
