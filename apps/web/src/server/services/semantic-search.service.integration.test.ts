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
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { enqueueEntityEmbeddingBackfill } from "./semantic-search.service";

describe("semantic search background jobs", () => {
  const ctx = withTestDb();

  it("processes embedding backfill inline when no queue is bound", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Backfill blue tarp",
      }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", product.entityId);

    const result = await enqueueEntityEmbeddingBackfill(ctx.db, {
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
