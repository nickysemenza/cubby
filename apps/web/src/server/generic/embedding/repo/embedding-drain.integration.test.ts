import type { SearchableEntityRef } from "@cubby/schemas/search";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { entityEmbedding } from "~/server/db/retained-tables";
import { deleteProducts } from "~/server/domains/product/repo/crud";
import {
  advanceEmbeddingFixture,
  embeddingWorkFor,
  markEmbeddingFixture,
} from "~/server/generic/embedding/repo/embedding-drain.fixtures";
import { embeddingCleanupDrain } from "~/server/generic/embedding/service/embedding-cleanup";
import { embeddingRefreshDrain } from "~/server/generic/embedding/service/embedding-refresh";
import {
  getSemanticEmbeddingConfig,
  type SemanticEmbeddingConfig,
} from "~/server/generic/embedding/service/semantic/config";
import type { VectorStorePort } from "~/server/generic/embedding/service/semantic/vector-store";
import { JobRetryableError } from "~/server/generic/jobs/errors";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import {
  createProductFixture,
  createProductIdentityFixture,
  makeProductInput,
  renameFixtureRaw,
} from "~/server/testing/repo.fixtures";
import { type EmbeddingRefreshPort } from "~/server/workflows/background-tasks/embedding";

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

const selectArtifacts = (db: Database, entityId: string) =>
  getDb(db)
    .select({
      id: entityEmbedding.id,
      artifactState: entityEmbedding.artifactState,
    })
    .from(entityEmbedding)
    .where(eq(entityEmbedding.entityId, entityId));

const markRefresh = markEmbeddingFixture;
const advanceRefresh = advanceEmbeddingFixture;

async function advanceCleanup(db: Database, store: VectorStorePort) {
  await getDb(db)
    .update(entityEmbedding)
    .set({ deletionRetryAt: null })
    .where(isNotNull(entityEmbedding.deletionRetryAt));
  await embeddingCleanupDrain(store).page(db, {
    deadline: Date.now() + 30_000,
  });
}

describe("embedding refresh and cleanup drains", () => {
  const ctx = withTestDb();

  // The hourly cron runs beside the queue consumer, and a publication can re-mark a
  // document at any moment. The generation says what is owed; only the lease says who
  // may pay, so neither a sibling nor a same-text re-mark can buy the embedding twice.
  it("pays once for a document re-marked with the same text while its provider call is in flight", async () => {
    const subject = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic overlap fixture" }),
      ctx.actor,
    );
    const ref = { entityKind: "product", entityId: subject.entityId } as const;
    const remote = fakeStore();
    const calls: string[][] = [];
    const inner = embeddingPort(remote.store, calls);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const port: EmbeddingRefreshPort = {
      ...inner,
      embed: async (...args) => {
        entered();
        await released;
        return inner.embed(...args);
      },
    };
    await markRefresh(ctx.db, [ref]);
    const deadline = () => ({ deadline: Date.now() + 30_000 });
    const first = embeddingRefreshDrain(port).page(ctx.db, deadline());
    await inFlight;

    await markRefresh(ctx.db, [ref]);
    const [remarked] = await embeddingWorkFor(ctx.db, [ref.entityId]);
    expect(remarked?.readyAt?.getTime()).toBeLessThanOrEqual(Date.now());
    const sibling = await embeddingRefreshDrain(port).page(ctx.db, deadline());
    expect(sibling.more).toBe(false);
    // The sibling waits for the lease rather than the due time.
    expect(sibling.nextAt?.getTime()).toBeGreaterThan(Date.now() + 60_000);

    release();
    const settled = await first;
    expect(calls).toHaveLength(1);
    // The latest intent is still owed and is claimable straight away.
    expect(settled.nextAt?.getTime()).toBeLessThanOrEqual(Date.now());
    const [submitted] = await selectArtifacts(ctx.db, ref.entityId);
    expect(submitted).toMatchObject({ artifactState: "submitted" });
    expect(remote.upserted).toHaveLength(1);

    await embeddingRefreshDrain(port).page(ctx.db, deadline());
    await advanceRefresh(ctx.db, port);
    expect(calls).toHaveLength(1);
    expect(remote.upserted).toHaveLength(1);
    expect(await embeddingWorkFor(ctx.db, [ref.entityId])).toEqual([]);
    expect(await selectArtifacts(ctx.db, ref.entityId)).toMatchObject([
      { id: submitted?.id, artifactState: "selected" },
    ]);
  });

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
    const [first] = await embeddingWorkFor(ctx.db, [ref.entityId]);
    expect(first).toMatchObject({ attempts: 0 });
    expect(first?.readyAt?.getTime()).toBeGreaterThan(Date.now());

    await advanceRefresh(ctx.db, port);
    const [second] = await embeddingWorkFor(ctx.db, [ref.entityId]);
    expect(second).toMatchObject({ attempts: 0 });

    remote.setVisible(true);
    await advanceRefresh(ctx.db, port);
    expect(await embeddingWorkFor(ctx.db, [ref.entityId])).toEqual([]);
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
      await embeddingWorkFor(
        ctx.db,
        refs.map((ref) => ref.entityId),
      ),
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
      const subject = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: `Synthetic byte fixture ${index}`,
          notes: "x".repeat(7_800),
        }),
        ctx.actor,
      );
      refs.push({ entityKind: "product", entityId: subject.entityId });
    }
    const long = await createProductIdentityFixture(
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
    const longItem = await embeddingWorkFor(ctx.db, [long.entityId]);
    expect(longItem).toHaveLength(1);
    expect(longItem[0]?.attempts).toBe(1);
    expect(
      await embeddingWorkFor(
        ctx.db,
        refs.slice(0, -1).map((ref) => ref.entityId),
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

    await advanceCleanup(ctx.db, remote.store);
    expect(remote.deleted.flat()).toContain(first.id);
    expect(remote.vectors.has(first.id)).toBe(false);
    expect(remote.vectors.has(replacement.id)).toBe(true);
  });

  it("backs off Vectorize 429 cleanup failures on the retired artifact", async () => {
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
    remote.setDeleteFailure(
      new JobRetryableError("Vectorize 429 Too Many Requests"),
    );
    const before = Date.now();

    await advanceCleanup(ctx.db, remote.store);
    const [work] = await getDb(ctx.db)
      .select({
        deletionId: entityEmbedding.deletionId,
        retryAt: entityEmbedding.deletionRetryAt,
      })
      .from(entityEmbedding)
      .where(eq(entityEmbedding.id, staged.id));
    expect(work?.deletionId).toBeNull();
    expect(work?.retryAt?.getTime()).toBeGreaterThan(before);
  });
});
