import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import {
  processBackgroundJob,
  type BackgroundQueueEmbeddingPort,
} from "~/server/background-queue";
import { createBackgroundBatchWithJobs } from "~/server/repo/background-jobs";
import {
  createProductFixture as createProduct,
  makeProductInput,
  updateProductNameFixtureRaw,
} from "~/server/repo/repo.fixtures";
import { refreshSearchDocument } from "~/server/repo/search-document";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";

// Configured-on, so the gate is what decides whether a provider call happens.
// The rest of the semantic suite deliberately runs UNCONFIGURED (every refresh
// skips before reaching the provider), which cannot tell "skipped because the
// text is unchanged" apart from "skipped because embeddings are off" — the very
// distinction these cases exist to pin.
const vector = (seed = 1): number[] =>
  Array.from({ length: 1536 }, (_, index) => ((index + seed) % 100) / 100);

const embeddedTextBatches: string[][] = [];
const configuredEmbeddingPort: BackgroundQueueEmbeddingPort = {
  configured: () => true,
  config: getSemanticEmbeddingConfig,
  embed: async (texts) => {
    embeddedTextBatches.push([...texts]);
    return texts.map((_, index) => vector(index + 1));
  },
};

/**
 * Guards the ordering in background-queue's entity-embedding.refresh handler:
 * the stored-hash comparison must happen BEFORE embedTexts. upsertEntityEmbedding
 * runs the same comparison afterwards, so a regression that moves the gate back
 * down still produces correct data and correct job outcomes — only the bill and
 * the queue lag change. Asserting call COUNT is the only thing that catches it.
 */
describe("entity-embedding refresh provider gate", () => {
  const ctx = withTestDb();

  beforeEach(() => {
    embeddedTextBatches.length = 0;
  });

  const runRefresh = async (entityId: string) => {
    const { jobIds } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "entity-embedding.refresh",
      source: "mutation",
      jobs: [
        {
          kind: "entity-embedding.refresh",
          dedupeKey: `entity-embedding.refresh:product:${entityId}:${crypto.randomUUID()}`,
          payload: { entityType: "product", entityId },
        },
      ],
    });
    const jobId = jobIds[0];
    if (!jobId) throw new Error("expected a job to be created");
    return await processBackgroundJob(
      ctx.db,
      jobId,
      "entity-embedding.refresh",
      configuredEmbeddingPort,
    );
  };

  const runBatchRefresh = async (
    entityIds: string[],
    expectedEmbeddingHashes?: Record<string, string>,
  ) => {
    const { jobIds } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "entity-embedding.refresh-batch",
      source: "backfill",
      jobs: [
        {
          kind: "entity-embedding.refresh-batch",
          dedupeKey: `entity-embedding.refresh-batch:test:${crypto.randomUUID()}`,
          payload: {
            refs: entityIds.map((entityId) => ({
              entityType: "product",
              entityId,
              expectedEmbeddingHash: expectedEmbeddingHashes?.[entityId],
            })),
          },
        },
      ],
    });
    const jobId = jobIds[0];
    if (!jobId) throw new Error("expected a job to be created");
    return await processBackgroundJob(
      ctx.db,
      jobId,
      "entity-embedding.refresh-batch",
      configuredEmbeddingPort,
    );
  };

  const stockProduct = async (name: string) => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", product.entityId);
    return product;
  };

  it("spends one provider call on a whole wave, then skips it unchanged", async () => {
    const products = [];
    for (const name of ["Batch red tarp", "Batch blue tarp", "Batch grey tarp"])
      products.push(await stockProduct(name));
    const entityIds = products.map((product) => product.entityId);

    expect(await runBatchRefresh(entityIds)).toBe("succeeded");
    expect(embeddedTextBatches).toHaveLength(1);
    expect(embeddedTextBatches[0]).toHaveLength(3);

    expect(await runBatchRefresh(entityIds)).toBe("skipped");
    expect(embeddedTextBatches).toHaveLength(1);
  });

  it("re-embeds only the row whose text moved", async () => {
    const changed = await stockProduct("Batch amber tarp");
    const unchanged = await stockProduct("Batch olive tarp");
    const entityIds = [changed.entityId, unchanged.entityId];

    expect(await runBatchRefresh(entityIds)).toBe("succeeded");
    expect(embeddedTextBatches).toHaveLength(1);

    await updateProductNameFixtureRaw(
      ctx.db,
      changed.entityId,
      "Batch violet tarp",
    );
    await refreshSearchDocument(ctx.db, "product", changed.entityId);

    expect(await runBatchRefresh(entityIds)).toBe("succeeded");
    expect(embeddedTextBatches).toHaveLength(2);
    expect(embeddedTextBatches[1]).toHaveLength(1);
    expect(embeddedTextBatches[1]?.[0]).toContain("Batch violet tarp");
  });

  it("embeds once, then skips the provider while the text is unchanged", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Gate blue tarp" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", product.entityId);

    expect(await runRefresh(product.entityId)).toBe("succeeded");
    expect(embeddedTextBatches).toHaveLength(1);

    // The mutation-sourced payload carries no expectedEmbeddingHash, so this is
    // the fan-out case: an unrelated edit re-projects the document and re-enqueues
    // a refresh whose embedded text is byte-identical.
    expect(await runRefresh(product.entityId)).toBe("skipped");
    expect(embeddedTextBatches).toHaveLength(1);
  });

  it("embeds again once the embedded text actually changes", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Gate green tarp" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", product.entityId);
    expect(await runRefresh(product.entityId)).toBe("succeeded");
    expect(embeddedTextBatches).toHaveLength(1);

    await updateProductNameFixtureRaw(
      ctx.db,
      product.entityId,
      "Gate orange tarp",
    );
    await refreshSearchDocument(ctx.db, "product", product.entityId);

    expect(await runRefresh(product.entityId)).toBe("succeeded");
    expect(embeddedTextBatches).toHaveLength(2);
  });
});
