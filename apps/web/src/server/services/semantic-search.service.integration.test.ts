import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { processBackgroundJob } from "~/server/background-queue";
import {
  createBackgroundBatchWithJobs,
  getBackgroundBatchDetail,
} from "~/server/repo/background-jobs";
import {
  createProductFixture as createProduct,
  makeProductInput,
  updateProductNameFixtureRaw,
} from "~/server/repo/repo.fixtures";
import {
  getSearchDocumentEmbeddingText,
  getStaleSearchDocumentEmbeddingTextPage,
  refreshSearchDocument,
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
  enqueueEmbeddingBackfillWorkflow,
  findSimilarEntitiesWorkflow,
} from "~/server/workflows/search.server";

describe("semantic search background jobs", () => {
  const ctx = withTestDb();

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

  it("resolves a public entity and dispatches exactly its requested refresh", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Refresh test kettle" }),
      ctx.actor,
    );
    const result = await requestEmbeddingRefreshWorkflow(ctx.db, {
      entityType: "product",
      entityId: product.id,
    });
    const detail = await getBackgroundBatchDetail(ctx.db, result.batchId);
    expect(result.totalJobs).toBe(1);
    expect(detail?.jobs).toHaveLength(1);
    expect(detail?.jobs[0]?.payload).toEqual({
      entityType: "product",
      entityId: product.entityId,
    });
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

  it("processes embedding backfill inline when no queue is bound", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Backfill blue tarp",
      }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", product.entityId);

    const result = await enqueueEmbeddingBackfillWorkflow(ctx.db, {
      entityTypes: ["product"],
    });

    const detail = await getBackgroundBatchDetail(ctx.db, result.batch.id);
    expect(result.reused).toBe(false);
    expect(detail?.kind).toBe("entity-embedding.backfill.coordinator");
    expect(detail?.processor).toBe("inline");
    expect(detail?.status).toBe("succeeded");
    expect(detail?.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "entity-embedding.refresh",
          status: "skipped",
          payload: {
            entityType: "product",
            entityId: product.entityId,
            expectedEmbeddingHash: expect.any(String),
          },
        }),
      ]),
    );
  });

  it("requeues current text when the source changes after its page is read", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Embedding before concurrent change" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", product.entityId);
    const page = await getStaleSearchDocumentEmbeddingTextPage(
      ctx.db,
      ["product"],
      getSemanticEmbeddingConfig(),
    );
    const inspected = page.rows.find(
      (row) => row.entityId === product.entityId,
    );
    expect(inspected).toBeDefined();

    const { batchId, jobIds } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "entity-embedding.backfill.coordinator",
      source: "backfill",
      jobs: [
        {
          kind: "entity-embedding.refresh",
          dedupeKey: `test:embedding:old:${product.entityId}`,
          payload: {
            entityType: "product",
            entityId: product.entityId,
            expectedEmbeddingHash: inspected!.expectedEmbeddingHash,
          },
        },
      ],
    });
    await updateProductNameFixtureRaw(
      ctx.db,
      product.entityId,
      "Embedding after concurrent change",
    );

    await expect(
      processBackgroundJob(
        ctx.db,
        jobIds[0]!,
        "entity-embedding.backfill.coordinator",
      ),
    ).resolves.toBe("skipped");

    const [detail, currentText] = await Promise.all([
      getBackgroundBatchDetail(ctx.db, batchId),
      getSearchDocumentEmbeddingText(ctx.db, "product", product.entityId),
    ]);
    const refreshJobs = detail?.jobs.filter(
      (job) => job.kind === "entity-embedding.refresh",
    );
    expect(refreshJobs).toHaveLength(2);
    expect(refreshJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "skipped",
          payload: expect.objectContaining({
            expectedEmbeddingHash: inspected!.expectedEmbeddingHash,
          }),
        }),
        expect.objectContaining({
          status: "skipped",
          payload: expect.objectContaining({
            expectedEmbeddingHash: expect.not.stringMatching(
              inspected!.expectedEmbeddingHash,
            ),
          }),
        }),
      ]),
    );
    expect(currentText?.embeddingText).toContain(
      "Embedding after concurrent change",
    );
  });
});
