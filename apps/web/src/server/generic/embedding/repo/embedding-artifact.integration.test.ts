import type { VectorizeVector } from "@cloudflare/workers-types";
import { entityRefKey } from "@cubby/schemas/entity";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, sql } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv, type getAiGateway } from "~/server/cf-env";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { job, entityEmbedding } from "~/server/db/schema";
import { deleteProducts } from "~/server/domains/product/repo/crud";
import { recordEmbeddingDeletion } from "~/server/generic/embedding/repo/embedding-cleanup";
import { seedEntityEmbedding } from "~/server/generic/embedding/repo/entity-embedding";
import { findSimilarEntitiesWorkflow } from "~/server/generic/embedding/service/semantic-similarity";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  createInMemoryVectorizeIndex,
  productionVectorStore,
} from "~/server/generic/embedding/service/semantic/vector-store";
import { withJobExecution } from "~/server/generic/jobs/context";
import { claimJob, publishJobPage } from "~/server/generic/jobs/repo/jobs";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import { prepareSearchDocuments } from "~/server/generic/search/repo/search-document";
import { getSearchDocumentEmbeddingText } from "~/server/generic/search/repo/search-document";
import {
  createProductFixture,
  createProductIdentityFixture,
  makeProductInput,
  renameFixtureRaw,
} from "~/server/testing/repo.fixtures";
import {
  refreshEntityEmbeddings,
  type EmbeddingRefreshPort,
} from "~/server/workflows/background-tasks/embedding";
import { enqueueEmbeddingRefs } from "~/server/workflows/background-tasks/embedding";
import { embeddingJobHandler } from "~/server/workflows/background-tasks/embedding";
import { executeWorkflow } from "~/server/workflows/runtime";

import {
  advanceEmbeddingFixture,
  embedFixtures,
  settleEmbeddingProjectionJobs,
} from "./embedding-job.fixtures";
import { getStoredEmbeddingHashes } from "./entity-embedding-refresh";

// Accepted external mutations can arrive after a newer upload or deletion.
describe("immutable embedding artifacts", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  it("records deletion only for the named retired artifact and preserves unrelated receipts", async () => {
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic cleanup scope" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", subject.entityId);
    const text = await getSearchDocumentEmbeddingText(
      ctx.db,
      "product",
      subject.entityId,
    );
    if (!text) throw new Error("Synthetic search projection missing");
    const input = { ...text, config: getSemanticEmbeddingConfig() };
    const first = await seedEntityEmbedding(ctx.db, input);
    const target = await seedEntityEmbedding(ctx.db, input);
    await recordEmbeddingDeletion(ctx.db, first, "synthetic-first-receipt");
    const selected = await seedEntityEmbedding(ctx.db, input);
    const read = () =>
      getDb(ctx.db).select().from(entityEmbedding).orderBy(entityEmbedding.id);
    const before = await read();
    await recordEmbeddingDeletion(ctx.db, target, "synthetic-target-receipt");
    const after = await read();
    expect(after.find((row) => row.id === first)).toEqual(
      before.find((row) => row.id === first),
    );
    expect(after.find((row) => row.id === target)).toMatchObject({
      artifactState: "retired",
      deletionId: "synthetic-target-receipt",
      deletedAt: expect.any(Date),
    });
    expect(after.find((row) => row.id === selected)).toEqual(
      before.find((row) => row.id === selected),
    );
    await recordEmbeddingDeletion(
      ctx.db,
      selected,
      "synthetic-rejected-receipt",
    );
    await recordEmbeddingDeletion(
      ctx.db,
      crypto.randomUUID(),
      "synthetic-missing-receipt",
    );
    expect(await read()).toEqual(after);
  });

  it("readmits a page of current Jobs without per-record transactions", async () => {
    const refs: Parameters<typeof prepareSearchDocuments>[1][number][] = [];
    for (let index = 0; index < 8; index++) {
      const subject = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: `Synthetic admission ${index}` }),
        ctx.actor,
      );
      refs.push({ entityKind: "product", entityId: subject.entityId });
    }
    const prepared = await prepareSearchDocuments(ctx.db, refs);
    const config = getSemanticEmbeddingConfig();
    const original = await enqueueEmbeddingRefs(ctx.db, prepared, config);
    const paused = original[0];
    const failed = original[1];
    if (!paused || !failed)
      throw new Error("Missing synthetic admission cohort");
    await getDb(ctx.db)
      .update(job)
      .set({ state: "paused" })
      .where(eq(job.id, paused.id));
    await getDb(ctx.db)
      .update(job)
      .set({ state: "failed" })
      .where(eq(job.id, failed.id));
    const single = await countTestDbQueries(() =>
      enqueueEmbeddingRefs(
        ctx.db,
        { entries: prepared.entries.slice(0, 1), missing: [] },
        config,
      ),
    );
    const page = await countTestDbQueries(() =>
      enqueueEmbeddingRefs(ctx.db, prepared, config),
    );
    expect(page.result.map((row) => row.id)).toEqual(
      original.map((row) => row.id),
    );
    expect(page.queryCount).toBe(single.queryCount);
    expect(page.result.map((row) => row.state)).toEqual([
      "paused",
      "failed",
      "queued",
      "queued",
      "queued",
      "queued",
      "queued",
      "queued",
    ]);
    const [, reversed] = await Promise.all([
      enqueueEmbeddingRefs(ctx.db, prepared, config),
      enqueueEmbeddingRefs(
        ctx.db,
        { entries: [...prepared.entries].reverse(), missing: [] },
        config,
      ),
    ]);
    expect(reversed.map((row) => row.id)).toEqual(
      original.map((row) => row.id).reverse(),
    );
  });

  it("never reuses an earlier physical identity when text changes and returns", async () => {
    const index = createInMemoryVectorizeIndex();
    const accepted: VectorizeVector[][] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
        VECTORIZE: {
          ...index,
          upsert: async (vectors: VectorizeVector[]) => {
            accepted.push(vectors);
            return { mutationId: crypto.randomUUID() };
          },
          getByIds: async (ids: string[]) =>
            ids.flatMap((id) => {
              const vector = index.vectors.get(id);
              return vector ? [vector] : [];
            }),
        },
      }),
    );
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic vector Alpha" }),
      ctx.actor,
    );
    const ref = { entityKind: "product" as const, entityId: subject.entityId };
    const config = getSemanticEmbeddingConfig();
    let providerCalls = 0;
    const port: EmbeddingRefreshPort = {
      configured: () => true,
      config: () => config,
      vectorStore: productionVectorStore,
      embed: async (texts) => {
        providerCalls++;
        return texts.map(() =>
          Array.from({ length: config.dimensions }, (_, index) =>
            index === 0 ? 1 : 0,
          ),
        );
      },
    };
    const upload = async (name: string) => {
      await renameFixtureRaw(ctx.db, "product", subject.entityId, name);
      await refreshSearchDocument(ctx.db, "product", subject.entityId);
      const [execution] = await enqueueEmbeddingRefs(
        ctx.db,
        await prepareSearchDocuments(ctx.db, [ref]),
        config,
      );
      if (!execution) throw new Error("Missing synthetic execution");
      await advanceEmbeddingFixture(ctx.db, execution.id, port);
      const batch = accepted.at(-1);
      const vector = batch?.[0];
      if (!vector) throw new Error("Synthetic upload missing");
      return { batch, vector };
    };
    const alpha = await upload("Synthetic vector Alpha");
    const beta = await upload("Synthetic vector Beta");
    const returned = await upload("Synthetic vector Alpha");
    expect(beta.vector.id).not.toBe(alpha.vector.id);
    expect(returned.vector.id).not.toBe(alpha.vector.id);
    expect(returned.vector.id).not.toBe(beta.vector.id);
    await index.upsert(returned.batch);
    await index.upsert(alpha.batch);
    await index.deleteByIds([alpha.vector.id]);
    expect(index.vectors.get(returned.vector.id)).toEqual(returned.vector);
    const paidCalls = providerCalls;
    await advanceEmbeddingFixture(ctx.db, returned.vector.id, port);
    expect(providerCalls).toBe(paidCalls);
    const [selected] = await getDb(ctx.db)
      .select({ id: entityEmbedding.id })
      .from(entityEmbedding)
      .where(
        and(
          eq(entityEmbedding.entityId, subject.entityId),
          eq(entityEmbedding.artifactState, "selected"),
        ),
      );
    expect(selected?.id).toBe(returned.vector.id);
    expect(
      (await getStoredEmbeddingHashes(ctx.db, [ref], config)).has(
        entityRefKey(ref.entityKind, ref.entityId),
      ),
    ).toBe(true);
  });

  // Deletion can commit after preparation and before selection. Selection must
  // wait for that transaction, then reject the deleted source rather than
  // inserting a live artifact after the deletion's cleanup already ran.
  it("rejects selection overlapping an uncommitted source deletion", async () => {
    const index = createInMemoryVectorizeIndex();
    setCfEnv(
      fromPartial<Env>({
        VECTORIZE: index,
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
      }),
    );
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic overlapping vector" }),
      ctx.actor,
    );
    const config = getSemanticEmbeddingConfig();
    const port: EmbeddingRefreshPort = {
      configured: () => true,
      config: () => config,
      vectorStore: productionVectorStore,
      embed: async (texts) =>
        texts.map(() =>
          Array.from({ length: config.dimensions }, (_, i) =>
            i === 0 ? 1 : 0,
          ),
        ),
    };
    const [saved] = await enqueueEmbeddingRefs(
      ctx.db,
      await prepareSearchDocuments(ctx.db, [
        { entityKind: "product", entityId: subject.entityId },
      ]),
      config,
    );
    if (!saved) throw new Error("Missing synthetic embedding Job");
    await advanceEmbeddingFixture(ctx.db, saved.id, port);
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, saved.id));
    const claim = await claimJob(ctx.db, saved.id);
    if (!claim) throw new Error("Missing synthetic selection claim");
    const prepared = await embeddingJobHandler(port).prepare(ctx.db, claim);
    if (!prepared.publish)
      throw new Error("Expected visible vector publication");

    const deleting = Promise.withResolvers<void>();
    const allowDeleteCommit = Promise.withResolvers<void>();
    const deletion = withTransactionDatabase(ctx.db, async (tx) => {
      await deleteProducts(tx, [subject.entityId], ctx.actor);
      deleting.resolve();
      await allowDeleteCommit.promise;
    });
    await deleting.promise;
    let publicationPid = 0;
    let settled = false;
    const publication = withJobExecution(ctx.db, claim, () =>
      publishJobPage(ctx.db, claim, prepared.page, async (tx) => {
        const pid = await getDb(tx).execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        publicationPid = pid.rows[0]?.pid ?? 0;
        await prepared.publish?.(tx);
      }),
    ).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await expect
        .poll(async () => {
          if (settled) return "published";
          const waiting = await getDb(ctx.db).execute(
            sql`SELECT 1 FROM pg_stat_activity WHERE pid=${publicationPid} AND wait_event_type='Lock'`,
          );
          return waiting.rows.length ? "blocked" : "starting";
        })
        .toBe("blocked");
    } finally {
      allowDeleteCommit.resolve();
      await deletion;
    }
    expect(await publication).toBeInstanceOf(Error);
    expect(
      await getDb(ctx.db)
        .select()
        .from(entityEmbedding)
        .where(
          and(
            eq(entityEmbedding.entityId, subject.entityId),
            eq(entityEmbedding.artifactState, "selected"),
          ),
        ),
    ).toEqual([]);
  });

  it("filters retired artifacts before trimming a public similarity result", async () => {
    const index = createInMemoryVectorizeIndex();
    setCfEnv(
      fromPartial<Env>({
        VECTORIZE: index,
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
        AI: {
          gateway: () =>
            fromPartial<NonNullable<ReturnType<typeof getAiGateway>>>({
              run: () => {},
            }),
        },
      }),
    );
    const source = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic similarity source" }),
      ctx.actor,
    );
    const target = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic old target" }),
      ctx.actor,
    );
    const config = getSemanticEmbeddingConfig();
    const port: EmbeddingRefreshPort = {
      configured: () => true,
      config: () => config,
      vectorStore: productionVectorStore,
      embed: async (texts) =>
        texts.map(() =>
          Array.from({ length: config.dimensions }, (_, index) =>
            index === 0 ? 1 : 0,
          ),
        ),
    };
    await embedFixtures(
      ctx.db,
      [source, target].map(({ entityId }) => ({
        entityKind: "product",
        entityId,
      })),
      port,
    );
    await renameFixtureRaw(
      ctx.db,
      "product",
      target.entityId,
      "Synthetic current target",
    );
    await embedFixtures(
      ctx.db,
      [{ entityKind: "product", entityId: target.entityId }],
      port,
    );
    await settleEmbeddingProjectionJobs(ctx.db);
    const result = await executeWorkflow(
      findSimilarEntitiesWorkflow.definition,
      {
        context: ctx.db,
        input: { pair: "product_to_product", sourceId: source.id, limit: 1 },
      },
    );
    expect(result).toMatchObject({
      status: "ready",
      results: [
        expect.objectContaining({
          entity: expect.objectContaining({
            id: target.id,
            title: "Synthetic current target",
          }),
        }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain(target.entityId);
  });

  it("keeps provider exhaustion across unrelated writes but admits changed text", async () => {
    const index = createInMemoryVectorizeIndex();
    setCfEnv(
      fromPartial<Env>({
        VECTORIZE: index,
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
      }),
    );
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic failed embedding" }),
      ctx.actor,
    );
    const ref = { entityKind: "product" as const, entityId: subject.entityId };
    let calls = 0;
    const port: EmbeddingRefreshPort = {
      configured: () => true,
      config: getSemanticEmbeddingConfig,
      vectorStore: productionVectorStore,
      embed: async () => {
        calls++;
        throw new Error("Synthetic embedding provider unavailable");
      },
    };
    const [execution] = await enqueueEmbeddingRefs(
      ctx.db,
      await prepareSearchDocuments(ctx.db, [ref]),
      port.config(),
    );
    if (!execution) throw new Error("Missing synthetic execution");
    for (let attempt = 0; attempt < 3; attempt++)
      await advanceEmbeddingFixture(ctx.db, execution.id, port);
    expect(calls).toBe(3);
    await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic unrelated embedding input" }),
      ctx.actor,
    );
    await refreshEntityEmbeddings(ctx.db, [ref], port);
    const [stopped] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.id, execution.id));
    expect(stopped?.state).toBe("failed");
    expect(stopped?.error).toContain(
      "Synthetic embedding provider unavailable",
    );
    expect(calls).toBe(3);
    await renameFixtureRaw(
      ctx.db,
      "product",
      subject.entityId,
      "Synthetic changed embedding input",
    );
    const [changed] = await enqueueEmbeddingRefs(
      ctx.db,
      await prepareSearchDocuments(ctx.db, [ref]),
      port.config(),
    );
    if (!changed) throw new Error("Missing changed execution");
    await advanceEmbeddingFixture(ctx.db, changed.id, port);
    expect(calls).toBe(4);
  });
});
