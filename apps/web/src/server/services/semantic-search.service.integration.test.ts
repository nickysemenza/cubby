import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import type { EmbeddingRefreshPort } from "~/server/background-tasks/embedding";
import { refreshEntityEmbedding } from "~/server/background-tasks/embedding";
import { setCfEnv } from "~/server/cf-env";
import {
  createProductFixture as createProduct,
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

/** The provider is the one external seam: a deterministic fake vector per call. */
const fakeEmbeddingPort = (calls: string[][]): EmbeddingRefreshPort => ({
  configured: () => true,
  config: getSemanticEmbeddingConfig,
  embed: async (texts) => {
    calls.push(texts);
    const { dimensions } = getSemanticEmbeddingConfig();
    return texts.map((_, index) =>
      Array.from({ length: dimensions }, (__, i) => (i === index ? 1 : 0)),
    );
  },
});

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

    await expect(refreshEntityEmbedding(ctx.db, ref, port)).resolves.toBe(
      "written",
    );
    // Duplicate or out-of-order delivery: the stored hash gates the provider.
    await expect(refreshEntityEmbedding(ctx.db, ref, port)).resolves.toBe(
      "fresh",
    );
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
    const racingPort: EmbeddingRefreshPort = {
      configured: () => true,
      config: getSemanticEmbeddingConfig,
      // The provider call is where the race lives: the source moves on while
      // the vector for the old text is in flight.
      embed: async (texts) => {
        await updateProductNameFixtureRaw(
          ctx.db,
          product.entityId,
          "Embedding after concurrent change",
        );
        await refreshSearchDocument(ctx.db, "product", product.entityId);
        const { dimensions } = getSemanticEmbeddingConfig();
        return texts.map(() => Array.from({ length: dimensions }, () => 0.5));
      },
    };

    await expect(refreshEntityEmbedding(ctx.db, ref, racingPort)).resolves.toBe(
      "obsolete",
    );
    const currentText = await getSearchDocumentEmbeddingText(
      ctx.db,
      "product",
      product.entityId,
    );
    expect(currentText?.embeddingText).toContain(
      "Embedding after concurrent change",
    );
    // Still awaiting: the next refresh embeds the current text.
    expect(
      await countUnembeddedSearchDocuments(
        ctx.db,
        getSemanticEmbeddingConfig(),
      ),
    ).toBe(1);
    const calls: string[][] = [];
    await expect(
      refreshEntityEmbedding(ctx.db, ref, fakeEmbeddingPort(calls)),
    ).resolves.toBe("written");
    expect(calls[0]?.[0]).toContain("Embedding after concurrent change");
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
    expect(
      published.filter((m) => m.task.kind === "entity-embedding.refresh"),
    ).toHaveLength(3);
  });
});
