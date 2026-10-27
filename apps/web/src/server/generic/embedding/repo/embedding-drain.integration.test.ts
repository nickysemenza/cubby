import type { SearchableEntityRef } from "@cubby/schemas/search";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { entityEmbedding, job, workItem } from "~/server/db/retained-tables";
import { deleteProducts } from "~/server/domains/product/repo/crud";
import {
  EMBEDDING_CLEANUP_DRAIN,
  EMBEDDING_CLEANUP_TARGET,
  queueEmbeddingCleanupPage,
} from "~/server/generic/embedding/repo/embedding-cleanup";
import {
  EMBEDDING_REFRESH_DRAIN,
  EMBEDDING_REFRESH_TARGET,
} from "~/server/generic/embedding/repo/embedding-drain";
import { embeddingCleanupHandler } from "~/server/generic/embedding/service/embedding-cleanup";
import { embeddingRefreshHandler } from "~/server/generic/embedding/service/embedding-refresh";
import {
  getSemanticEmbeddingConfig,
  type SemanticEmbeddingConfig,
} from "~/server/generic/embedding/service/semantic/config";
import type { VectorStorePort } from "~/server/generic/embedding/service/semantic/vector-store";
import { JobRetryableError } from "~/server/generic/jobs/errors";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import {
  prepareSearchDocuments,
  refreshSearchDocument,
} from "~/server/generic/search/repo/search-document";
import {
  createProductFixture,
  makeProductInput,
  renameFixtureRaw,
} from "~/server/testing/repo.fixtures";
import {
  enqueueEmbeddingRefs,
  type EmbeddingRefreshPort,
} from "~/server/workflows/background-tasks/embedding";

const config = getSemanticEmbeddingConfig();

function fakeStore() {
  const vectors = new Map<string, number[]>();
  const deleted: string[][] = [];
  const upserted: Array<
    { id: string; entityKind: string; values: number[] }[]
  > = [];
  let visible = true;
  let deleteFailure: Error | undefined;
  const store: VectorStorePort = {
    configured: () => true,
    async upsert(items) {
      upserted.push([...items]);
      for (const item of items) vectors.set(item.id, [...item.values]);
      return new Map(items.map((item) => [item.id, `upload-${item.id}`]));
    },
    async deleteByIds(ids) {
      deleted.push([...ids]);
      if (deleteFailure) throw deleteFailure;
      for (const id of ids) vectors.delete(id);
      return new Map(ids.map((id) => [id, `delete-${id}`]));
    },
    async getByIds(ids) {
      return visible
        ? ids.flatMap((id) => {
            const values = vectors.get(id);
            return values ? [{ id, values }] : [];
          })
        : [];
    },
    async query() {
      return [];
    },
    async queryById(id) {
      return vectors.has(id) ? [{ id, similarity: 1 }] : [];
    },
  };
  return {
    store,
    vectors,
    deleted,
    upserted,
    setVisible(value: boolean) {
      visible = value;
    },
    setDeleteFailure(error?: Error) {
      deleteFailure = error;
    },
  };
}

function embeddingPort(
  store: VectorStorePort,
  calls: string[][] = [],
  configProvider = () => config,
  rejectLongInput = false,
): EmbeddingRefreshPort {
  return {
    configured: () => true,
    config: configProvider,
    vectorStore: store,
    async embed(texts) {
      calls.push([...texts]);
      if (
        rejectLongInput &&
        texts.some((text) => new TextEncoder().encode(text).length > 8_192)
      )
        throw new Error("Embedding input exceeds the provider limit");
      const { dimensions } = configProvider();
      return texts.map((text) => {
        const values = Array.from({ length: dimensions }, () => 0);
        values[0] = text.length;
        return values;
      });
    },
  };
}

async function markRefresh(
  db: Parameters<typeof enqueueEmbeddingRefs>[0],
  refs: SearchableEntityRef[],
) {
  await enqueueEmbeddingRefs(db, await prepareSearchDocuments(db, refs));
}

async function advanceRefresh(
  db: Parameters<typeof advanceJob>[0],
  port: EmbeddingRefreshPort,
) {
  const [execution] = await getDb(db)
    .select({ id: job.id })
    .from(job)
    .where(eq(job.key, EMBEDDING_REFRESH_DRAIN.key))
    .limit(1);
  if (!execution) throw new Error("Missing embedding refresh drain");
  await getDb(db)
    .update(job)
    .set({ availableAt: new Date(0) })
    .where(eq(job.id, execution.id));
  await getDb(db)
    .update(workItem)
    .set({ readyAt: new Date(0) })
    .where(eq(workItem.drain, EMBEDDING_REFRESH_DRAIN.key));
  await advanceJob(db, execution.id, {
    "embedding.refresh": embeddingRefreshHandler(port),
  });
}

async function advanceCleanup(
  db: Parameters<typeof advanceJob>[0],
  store: VectorStorePort,
) {
  const [execution] = await getDb(db)
    .select({ id: job.id })
    .from(job)
    .where(eq(job.key, EMBEDDING_CLEANUP_DRAIN.key))
    .limit(1);
  if (!execution) throw new Error("Missing embedding cleanup drain");
  await getDb(db)
    .update(job)
    .set({ availableAt: new Date(0) })
    .where(eq(job.id, execution.id));
  await getDb(db)
    .update(workItem)
    .set({ readyAt: new Date(0) })
    .where(eq(workItem.drain, EMBEDDING_CLEANUP_DRAIN.key));
  await advanceJob(db, execution.id, {
    "embedding.cleanup": embeddingCleanupHandler(store),
  });
}

describe("embedding refresh and cleanup drains", () => {
  const ctx = withTestDb();

  it("postpones Vectorize visibility polling without spending a work attempt", async () => {
    const subject = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic visibility fixture" }),
      ctx.actor,
    );
    const ref = { entityKind: "product", entityId: subject.entityId } as const;
    const remote = fakeStore();
    remote.setVisible(false);
    const port = embeddingPort(remote.store);
    await markRefresh(ctx.db, [ref]);

    await advanceRefresh(ctx.db, port);
    const [first] = await getDb(ctx.db)
      .select()
      .from(workItem)
      .where(
        and(
          eq(workItem.target, EMBEDDING_REFRESH_TARGET),
          eq(workItem.ref, ref.entityId),
        ),
      );
    expect(first).toMatchObject({ attempts: 0 });
    expect(first?.readyAt.getTime()).toBeGreaterThan(Date.now());

    await advanceRefresh(ctx.db, port);
    const [second] = await getDb(ctx.db)
      .select()
      .from(workItem)
      .where(
        and(
          eq(workItem.target, EMBEDDING_REFRESH_TARGET),
          eq(workItem.ref, ref.entityId),
        ),
      );
    expect(second).toMatchObject({ attempts: 0 });

    remote.setVisible(true);
    await advanceRefresh(ctx.db, port);
    expect(
      await getDb(ctx.db)
        .select({ id: workItem.ref })
        .from(workItem)
        .where(
          and(
            eq(workItem.target, EMBEDDING_REFRESH_TARGET),
            eq(workItem.ref, ref.entityId),
          ),
        ),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ id: entityEmbedding.id })
        .from(entityEmbedding)
        .where(
          and(
            eq(entityEmbedding.entityId, ref.entityId),
            eq(entityEmbedding.artifactState, "selected"),
            isNull(entityEmbedding.deletedAt),
          ),
        ),
    ).toHaveLength(1);
  });

  it("re-admits a pending artifact when its embedding configuration changed", async () => {
    const subject = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic config mismatch fixture" }),
      ctx.actor,
    );
    const ref = { entityKind: "product", entityId: subject.entityId } as const;
    const previousId = crypto.randomUUID();
    const previousModel =
      config.model === "text-embedding-3-small"
        ? "text-embedding-3-large"
        : "text-embedding-3-small";
    await getDb(ctx.db)
      .insert(entityEmbedding)
      .values({
        id: previousId,
        entityKind: "product",
        entityId: ref.entityId,
        embeddingText: "old synthetic text",
        embeddingHash: "old-hash",
        artifactHash: "old-hash",
        provider: config.provider,
        model: previousModel,
        dimensions: previousModel === "text-embedding-3-large" ? 3072 : 1536,
        artifactState: "submitted",
        vectorHash: "old-vector-hash",
        submissionId: "old-submission",
        observedAt: new Date(),
      });
    const remote = fakeStore();
    const calls: string[][] = [];
    const port = embeddingPort(remote.store, calls, () => config);
    await markRefresh(ctx.db, [ref]);

    await advanceRefresh(ctx.db, port);
    await advanceRefresh(ctx.db, port);
    const [oldArtifact] = await getDb(ctx.db)
      .select()
      .from(entityEmbedding)
      .where(eq(entityEmbedding.id, previousId));
    const [selected] = await getDb(ctx.db)
      .select()
      .from(entityEmbedding)
      .where(
        and(
          eq(entityEmbedding.entityId, ref.entityId),
          eq(entityEmbedding.artifactState, "selected"),
          isNull(entityEmbedding.deletedAt),
        ),
      );
    expect(oldArtifact).toMatchObject({ artifactState: "failed" });
    expect(oldArtifact?.deletedAt).toBeInstanceOf(Date);
    expect(selected?.id).not.toBe(previousId);
    expect(calls).toHaveLength(1);
  });

  it("drops a removed source alone while the other source is selected", async () => {
    const removed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic removed fixture" }),
      ctx.actor,
    );
    const live = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic live fixture" }),
      ctx.actor,
    );
    const refs = [
      { entityKind: "product", entityId: removed.entityId },
      { entityKind: "product", entityId: live.entityId },
    ] as const;
    await markRefresh(ctx.db, [...refs]);
    await deleteProducts(ctx.db, [removed.entityId], ctx.actor);
    const remote = fakeStore();
    const port = embeddingPort(remote.store);

    await advanceRefresh(ctx.db, port);
    await advanceRefresh(ctx.db, port);
    expect(
      await getDb(ctx.db)
        .select({ ref: workItem.ref })
        .from(workItem)
        .where(eq(workItem.target, EMBEDDING_REFRESH_TARGET)),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ id: entityEmbedding.id })
        .from(entityEmbedding)
        .where(
          and(
            eq(entityEmbedding.entityId, live.entityId),
            eq(entityEmbedding.artifactState, "selected"),
            isNull(entityEmbedding.deletedAt),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await getDb(ctx.db)
        .select({ id: entityEmbedding.id })
        .from(entityEmbedding)
        .where(eq(entityEmbedding.entityId, removed.entityId)),
    ).toEqual([]);
  });

  it("chunks provider requests by byte limits and isolates a long input", async () => {
    const refs: SearchableEntityRef[] = [];
    for (let index = 0; index < 39; index++) {
      const subject = await createProductFixture(
        ctx.db,
        makeProductInput({
          name: `Synthetic byte fixture ${index}`,
          notes: "x".repeat(7_800),
        }),
        ctx.actor,
      );
      refs.push({ entityKind: "product", entityId: subject.entityId });
    }
    const long = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic long input fixture",
        notes: "y".repeat(9_000),
      }),
      ctx.actor,
    );
    refs.push({ entityKind: "product", entityId: long.entityId });
    await markRefresh(ctx.db, refs);
    const remote = fakeStore();
    const calls: string[][] = [];
    const port = embeddingPort(remote.store, calls, () => config, true);

    await advanceRefresh(ctx.db, port);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((batch) => batch.length <= 2048)).toBe(true);
    expect(
      calls.every(
        (batch) =>
          batch.reduce(
            (total, text) => total + new TextEncoder().encode(text).length,
            0,
          ) <= 300_000,
      ),
    ).toBe(true);
    const longItem = await getDb(ctx.db)
      .select()
      .from(workItem)
      .where(
        and(
          eq(workItem.target, EMBEDDING_REFRESH_TARGET),
          eq(workItem.ref, long.entityId),
        ),
      );
    expect(longItem).toHaveLength(1);
    expect(longItem[0]?.attempts).toBe(1);
    expect(
      await getDb(ctx.db)
        .select({ ref: workItem.ref })
        .from(workItem)
        .where(
          and(
            eq(workItem.target, EMBEDDING_REFRESH_TARGET),
            inArray(
              workItem.ref,
              refs.slice(0, -1).map((ref) => ref.entityId),
            ),
          ),
        ),
    ).toHaveLength(39);
  });

  it("keeps delayed cleanup bound to its retired vector after a replacement upload", async () => {
    const subject = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic replacement fixture Alpha" }),
      ctx.actor,
    );
    const ref = { entityKind: "product", entityId: subject.entityId } as const;
    const remote = fakeStore();
    let activeConfig: SemanticEmbeddingConfig = config;
    const port = embeddingPort(remote.store, [], () => activeConfig);
    await markRefresh(ctx.db, [ref]);
    await advanceRefresh(ctx.db, port);
    await advanceRefresh(ctx.db, port);
    const [first] = await getDb(ctx.db)
      .select({ id: entityEmbedding.id })
      .from(entityEmbedding)
      .where(
        and(
          eq(entityEmbedding.entityId, ref.entityId),
          eq(entityEmbedding.artifactState, "selected"),
          isNull(entityEmbedding.deletedAt),
        ),
      );
    if (!first) throw new Error("Missing first selected artifact");

    await renameFixtureRaw(
      ctx.db,
      "product",
      ref.entityId,
      "Synthetic replacement fixture Beta",
    );
    await refreshSearchDocument(ctx.db, "product", ref.entityId);
    await markRefresh(ctx.db, [ref]);
    activeConfig = { ...config, dimensions: config.dimensions + 1 };
    await advanceRefresh(ctx.db, port);
    await advanceRefresh(ctx.db, port);
    const [replacement] = await getDb(ctx.db)
      .select({ id: entityEmbedding.id })
      .from(entityEmbedding)
      .where(
        and(
          eq(entityEmbedding.entityId, ref.entityId),
          eq(entityEmbedding.artifactState, "selected"),
          isNull(entityEmbedding.deletedAt),
        ),
      );
    if (!replacement) throw new Error("Missing replacement artifact");
    expect(replacement.id).not.toBe(first.id);

    await queueEmbeddingCleanupPage(ctx.db);
    await advanceCleanup(ctx.db, remote.store);
    expect(remote.deleted.flat()).toContain(first.id);
    expect(remote.vectors.has(first.id)).toBe(false);
    expect(remote.vectors.has(replacement.id)).toBe(true);
  });

  it("backs off Vectorize 429 cleanup failures on the cleanup WorkItem", async () => {
    const subject = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic cleanup rate limit" }),
      ctx.actor,
    );
    const ref = { entityKind: "product", entityId: subject.entityId } as const;
    const remote = fakeStore();
    const port = embeddingPort(remote.store);
    await markRefresh(ctx.db, [ref]);
    await advanceRefresh(ctx.db, port);
    const [staged] = await getDb(ctx.db)
      .select({ id: entityEmbedding.id })
      .from(entityEmbedding)
      .where(eq(entityEmbedding.entityId, ref.entityId));
    if (!staged) throw new Error("Missing staged artifact");
    await getDb(ctx.db)
      .update(entityEmbedding)
      .set({ artifactState: "retired", deletedAt: new Date() })
      .where(eq(entityEmbedding.id, staged.id));
    await queueEmbeddingCleanupPage(ctx.db);
    remote.setDeleteFailure(
      new JobRetryableError("Vectorize 429 Too Many Requests"),
    );
    const before = Date.now();

    await advanceCleanup(ctx.db, remote.store);
    const [work] = await getDb(ctx.db)
      .select()
      .from(workItem)
      .where(
        and(
          eq(workItem.target, EMBEDDING_CLEANUP_TARGET),
          eq(workItem.ref, staged.id),
        ),
      );
    expect(work?.attempts).toBe(1);
    expect(work?.lastError).toContain("429");
    expect(work?.readyAt.getTime()).toBeGreaterThan(before);
  });
});
