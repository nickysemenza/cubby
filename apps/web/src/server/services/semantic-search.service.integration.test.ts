import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { getBackgroundBatchDetail } from "~/server/repo/background-jobs";
import { createProduct } from "~/server/repo/product";
import { makeProductInput } from "~/server/repo/repo.fixtures";
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

    const result = await enqueueEntityEmbeddingBackfill(ctx.db, {
      entityTypes: ["product"],
      limit: 50,
    });

    const detail = await getBackgroundBatchDetail(ctx.db, result.batchId);
    expect(result.totalJobs).toBeGreaterThan(0);
    expect(detail?.kind).toBe("entity-embedding.refresh");
    expect(detail?.processor).toBe("inline");
    expect(detail?.status).toBe("succeeded");
    expect(detail?.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "entity-embedding.refresh",
          status: "skipped",
          payload: {
            entityType: "product",
            entityId: product.id,
          },
        }),
      ]),
    );
  });
});
