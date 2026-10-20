import { searchRepairCheckpoint } from "@cubby/schemas/maintenance";
import { fromPartial } from "@total-typescript/shoehorn";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { resolveDatabaseRuntime } from "~/server/db/database-runtime";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
} from "~/server/generic/search/repo/search-document";
import { memoryDurableSteps } from "~/server/testing/durable-steps";
import {
  createProductFixture as createProduct,
  makeProductInput,
  seedSearchDocumentsFixtureRaw,
  renameFixtureRaw,
} from "~/server/testing/repo.fixtures";
import { runSearchRepairSourcePage } from "~/server/workflows/runs/search-repair-page";
import type { DurableSteps } from "~/server/workflows/runs/step";

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

  it("retains a selected repair page after a committed projection loses its acknowledgment", async () => {
    const { activateWorkflowDeployment } =
      await import("~/server/workflows/runs/activation");
    const { createSearchIndexRepairCounters } =
      await import("./search-index-repair.service");
    const missing = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic lost repair acknowledgment" }),
      ctx.actor,
    );
    const refs = [
      { entityKind: "product" as const, entityId: missing.entityId },
    ];
    const published = recordingQueue();
    await activateWorkflowDeployment(ctx.db, {
      deploymentId: "synthetic-repair-a",
      workerVersion: "synthetic-a",
      expectedEpoch: 0,
    });
    const durable = memoryDurableSteps();
    let loseAcknowledgment = true;
    const steps: DurableSteps = {
      ...durable.steps,
      do: (name, config, callback) =>
        durable.steps.do(name, config, async () => {
          const value = await callback();
          if (name.endsWith(".apply") && loseAcknowledgment) {
            loseAcknowledgment = false;
            await activateWorkflowDeployment(ctx.db, {
              deploymentId: "synthetic-repair-b",
              workerVersion: "synthetic-b",
              expectedEpoch: 1,
            });
            throw new Error(
              "Synthetic Workflow acknowledgment lost after commit",
            );
          }
          return value;
        }),
    };
    const result = await runSearchRepairSourcePage({
      name: "synthetic-source-page",
      requestedAt: new Date().toISOString(),
      pending: {
        stage: "apply",
        page: {
          refs,
          nextCursor: null,
          delta: { scanned: 1, missing: 1, stale: 0 },
        },
      },
      identity: { version: "synthetic-a", epoch: 1 },
      steps,
      database: (work) => work(ctx.db),
    });
    expect(
      await getSearchDocumentEmbeddingText(ctx.db, "product", missing.entityId),
    ).not.toBeNull();
    expect(published).toEqual([]);
    expect(result).toMatchObject({
      kind: "interrupted",
      pending: { stage: "apply", page: { refs } },
    });
    if (result.kind !== "interrupted" || !result.pending)
      throw new Error("Repair selection was not retained");
    const checkpoint = searchRepairCheckpoint.parse(
      JSON.parse(
        JSON.stringify({
          phase: "sources",
          cursor: null,
          counters: createSearchIndexRepairCounters(),
          pendingSource: result.pending,
        }),
      ),
    );
    if (!checkpoint.pendingSource)
      throw new Error("Repair handoff lost its selected page");
    const resumed = await runSearchRepairSourcePage({
      name: "synthetic-successor-page",
      requestedAt: new Date().toISOString(),
      pending: checkpoint.pendingSource,
      identity: { version: "synthetic-b", epoch: 2 },
      steps: memoryDurableSteps().steps,
      database: (work) => work(ctx.db),
    });
    expect(resumed).toMatchObject({
      kind: "done",
      nextCursor: null,
      delta: { published: 1, scanned: 1 },
    });
    expect(published.map((message) => message.task.entityId)).toContain(
      missing.entityId,
    );
  });

  it("rejects repair effects retried after a deployment and resumes on the activated epoch", async () => {
    const { activateWorkflowDeployment } =
      await import("~/server/workflows/runs/activation");
    const { withWorkflowDeploymentEffect } =
      await import("~/server/workflows/runs/execution");
    const {
      applySearchIndexRepairSourcePage,
      publishSearchIndexRepairSourcePage,
    } = await import("./search-index-repair.service");
    const missing = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic deployment repair" }),
      ctx.actor,
    );
    const refs = [
      { entityKind: "product" as const, entityId: missing.entityId },
    ];
    const published = recordingQueue();
    await activateWorkflowDeployment(ctx.db, {
      deploymentId: "synthetic-repair-a",
      workerVersion: "synthetic-a",
      expectedEpoch: 0,
    });
    await activateWorkflowDeployment(ctx.db, {
      deploymentId: "synthetic-repair-b",
      workerVersion: "synthetic-b",
      expectedEpoch: 1,
    });
    await activateWorkflowDeployment(ctx.db, {
      deploymentId: "synthetic-repair-rollback",
      workerVersion: "synthetic-a",
      expectedEpoch: 2,
    });
    const stale = { version: "synthetic-a", epoch: 1 };
    await expect(
      withWorkflowDeploymentEffect(ctx.db, stale, (tx) =>
        applySearchIndexRepairOrphanPage(tx, refs),
      ),
    ).rejects.toMatchObject({ reason: "deployment" });
    await expect(
      withWorkflowDeploymentEffect(ctx.db, stale, (tx) =>
        applySearchIndexRepairSourcePage(tx, refs),
      ),
    ).rejects.toMatchObject({ reason: "deployment" });
    await expect(
      withWorkflowDeploymentEffect(ctx.db, stale, (tx) =>
        publishSearchIndexRepairSourcePage(tx, refs, new Date().toISOString()),
      ),
    ).rejects.toMatchObject({ reason: "deployment" });
    expect(
      await getSearchDocumentEmbeddingText(ctx.db, "product", missing.entityId),
    ).toBeNull();
    expect(published).toEqual([]);
    const current = { version: "synthetic-a", epoch: 3 };
    await expect(
      withWorkflowDeploymentEffect(ctx.db, current, (tx) =>
        applySearchIndexRepairSourcePage(tx, refs),
      ),
    ).resolves.toEqual({ rebuilt: 1 });
    await expect(
      withWorkflowDeploymentEffect(ctx.db, current, (tx) =>
        publishSearchIndexRepairSourcePage(tx, refs, new Date().toISOString()),
      ),
    ).resolves.toEqual({ published: 1 });
    expect(published.map((message) => message.task.entityId)).toContain(
      missing.entityId,
    );
  });

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
    await renameFixtureRaw(ctx.db, "product", stale.entityId, "Renamed raw");
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
    await resolveDatabaseRuntime(ctx.db).withConnection((client) =>
      client.execute(sql`
        UPDATE "Product" SET "deletedAt" = now()
        WHERE id = ${restored.entityId}::uuid
      `),
    );
    const page = await selectSearchIndexRepairOrphanPage(ctx.db);
    expect(page.refs).toContainEqual({
      entityKind: "product",
      entityId: restored.entityId,
    });

    // The Workflow may apply this persisted page much later. Its transaction
    // must recheck liveness rather than retiring the selection blindly.
    await resolveDatabaseRuntime(ctx.db).withConnection((client) =>
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
