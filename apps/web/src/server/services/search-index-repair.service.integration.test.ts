import { fromPartial } from "@total-typescript/shoehorn";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import {
  createProductFixture as createProduct,
  makeProductInput,
  seedSearchDocumentsFixtureRaw,
  updateProductNameFixtureRaw,
} from "~/server/repo/repo.fixtures";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
} from "~/server/repo/search-document";

import {
  applySearchIndexRepairOrphanPage,
  repairSearchIndex,
  selectSearchIndexRepairOrphanPage,
} from "./search-index-repair.service";

describe("search index repair stream", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  const recordingQueue = () => {
    const published: Array<{ task: { entityId: string } }> = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: { task: { entityId: string } } }>,
          ) => {
            published.push(...[...messages].map((m) => m.body));
          },
        },
      }),
    );
    return published;
  };

  it("retires orphans, rebuilds missing and stale projections, publishes embeddings, and pages", async () => {
    // Orphans: documents with no source, more than one page of them.
    await seedSearchDocumentsFixtureRaw(ctx.db, "product", 251);
    // Missing: a product with no document at all.
    const missing = await createProduct(
      ctx.db,
      makeProductInput({ name: "Never projected" }),
      ctx.actor,
    );
    // Stale: a product whose document predates a raw rename.
    const stale = await createProduct(
      ctx.db,
      makeProductInput({ name: "Projected then renamed" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", stale.entityId);
    await updateProductNameFixtureRaw(ctx.db, stale.entityId, "Renamed raw");
    const published = recordingQueue();

    const events = [];
    for await (const event of repairSearchIndex(ctx.db)) events.push(event);

    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("stream did not finish");
    // Two missing: the product and the ingredient the fixture minted for it.
    expect(done.result).toMatchObject({
      orphaned: 251,
      retired: 251,
      missing: 2,
      stale: 1,
      rebuilt: 3,
      published: 3,
    });
    expect(done.result.scanned).toBeGreaterThanOrEqual(254);
    // Progress was reported per page in both phases, in the bulk-stream shape.
    const orphanTicks = events.filter(
      (e) => e.type === "progress" && e.phase === "orphans",
    );
    expect(orphanTicks).toHaveLength(2);
    expect(orphanTicks[0]).toMatchObject({ done: 250, total: 500 });
    // The last page also scans the live documents seeded alongside the
    // orphans, so only its shape is fixed: no further page is promised.
    const lastOrphanTick = orphanTicks[1];
    if (lastOrphanTick?.type !== "progress") throw new Error("missing tick");
    expect(lastOrphanTick.done).toBeGreaterThanOrEqual(251);
    expect(lastOrphanTick.total).toBe(lastOrphanTick.done);
    expect(
      events.some((e) => e.type === "progress" && e.phase === "sources"),
    ).toBe(true);

    const rebuilt = await getSearchDocumentEmbeddingText(
      ctx.db,
      "product",
      stale.entityId,
    );
    expect(rebuilt?.embeddingText).toContain("Renamed raw");
    expect(
      await getSearchDocumentEmbeddingText(ctx.db, "product", missing.entityId),
    ).not.toBeNull();
    expect(published.map((m) => m.task.entityId)).toEqual(
      expect.arrayContaining([missing.entityId, stale.entityId]),
    );
  });

  it("stops between pages when cancelled", async () => {
    await seedSearchDocumentsFixtureRaw(ctx.db, "product", 2);
    const controller = new AbortController();
    const stream = repairSearchIndex(ctx.db, controller.signal);
    await stream.next();
    controller.abort();
    await expect(stream.next()).rejects.toThrow(/cancelled/i);
  });

  it("does not retire an orphan candidate that became live before its page applies", async () => {
    const restored = await createProduct(
      ctx.db,
      makeProductInput({ name: "Restored source" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", restored.entityId);

    // Model a source disappearing outside the normal deletion cascade, which
    // makes its still-live SearchDocument a repair candidate.
    await ctx.db.withClientConnection((client) =>
      client.execute(sql`
        UPDATE "Product" SET "deletedAt" = now()
        WHERE id = ${restored.entityId}::uuid
      `),
    );
    const page = await selectSearchIndexRepairOrphanPage(ctx.db);
    expect(page.refs).toContainEqual({
      entityType: "product",
      entityId: restored.entityId,
    });

    // The Workflow may apply this persisted page much later. Its transaction
    // must recheck liveness rather than retiring the selection blindly.
    await ctx.db.withClientConnection((client) =>
      client.execute(sql`
        UPDATE "Product" SET "deletedAt" = NULL
        WHERE id = ${restored.entityId}::uuid
      `),
    );
    const applied = await applySearchIndexRepairOrphanPage(ctx.db, page.refs);
    expect(applied.retired).toBe(0);
    expect(
      await getSearchDocumentEmbeddingText(
        ctx.db,
        "product",
        restored.entityId,
      ),
    ).not.toBeNull();
  });
});
