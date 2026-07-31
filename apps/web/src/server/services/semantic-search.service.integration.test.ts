import { taskCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { getBackgroundBatchDetail } from "~/server/repo/background-jobs";
import {
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { createTask } from "~/server/repo/task";
import {
  enqueueEntityEmbeddingBackfill,
  hybridGlobalSearch,
  lexicalGlobalSearch,
} from "./semantic-search.service";

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
            entityId: product.entityId,
          },
        }),
      ]),
    );
  });
});

describe("scoped global search", () => {
  const ctx = withTestDb();

  it("restricts lexical results to the requested entity type", async () => {
    await Promise.all([
      createProduct(
        ctx.db,
        makeProductInput({ name: "Scoped manifest drill product" }),
        ctx.actor,
      ),
      createTask(
        ctx.db,
        mock(taskCreateInput, {
          overrides: { name: "Scoped manifest drill task" },
        }),
        ctx.actor,
      ),
    ]);

    const results = await lexicalGlobalSearch(
      ctx.db,
      "Scoped manifest drill",
      10,
      "task",
    );

    expect(results).not.toHaveLength(0);
    expect(results.every((result) => result.entityType === "task")).toBe(true);
  });

  it("restricts hybrid results before the semantic minimum query length", async () => {
    await Promise.all([
      createProduct(
        ctx.db,
        makeProductInput({ name: "Qz scoped product" }),
        ctx.actor,
      ),
      createTask(
        ctx.db,
        mock(taskCreateInput, {
          overrides: { name: "Qz scoped task" },
        }),
        ctx.actor,
      ),
    ]);

    const results = await hybridGlobalSearch(ctx.db, "Qz", 10, "product");

    expect(results).not.toHaveLength(0);
    expect(results.every((result) => result.entityType === "product")).toBe(
      true,
    );
  });
});
