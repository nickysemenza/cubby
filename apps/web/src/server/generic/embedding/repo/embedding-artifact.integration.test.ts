import type { VectorizeVector } from "@cloudflare/workers-types";
import { entityRefKey } from "@cubby/schemas/entity";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv, type getAiGateway } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { derivedRefreshWork, entityEmbedding } from "~/server/db/schema";
import { findSimilarEntitiesWorkflow } from "~/server/generic/embedding/service/semantic-similarity";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  createInMemoryVectorizeIndex,
  productionVectorStore,
} from "~/server/generic/embedding/service/semantic/vector-store";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import {
  createProductFixture,
  makeProductInput,
  renameFixtureRaw,
} from "~/server/testing/repo.fixtures";
import {
  refreshEntityEmbeddings,
  recoverEmbeddingArtifactsPage,
  type EmbeddingRefreshPort,
} from "~/server/workflows/background-tasks/embedding";
import { executeWorkflow } from "~/server/workflows/runtime";

import { getStoredEmbeddingHashes } from "./entity-embedding-refresh";

// Accepted external mutations can arrive after a newer upload or deletion.
describe("immutable embedding artifacts", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

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
    const subject = await createProductFixture(
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
      // Isolate external ordering from projection-frontier scheduling.
      await getDb(ctx.db)
        .update(derivedRefreshWork)
        .set({ state: "completed", publishing: true });
      await refreshEntityEmbeddings(ctx.db, [ref], port);
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
    await getDb(ctx.db)
      .update(entityEmbedding)
      .set({ availableAt: new Date(0) })
      .where(eq(entityEmbedding.id, returned.vector.id));
    expect((await recoverEmbeddingArtifactsPage(ctx.db, port)).errors).toEqual(
      [],
    );
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
    await refreshEntityEmbeddings(
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
    await refreshEntityEmbeddings(
      ctx.db,
      [{ entityKind: "product", entityId: target.entityId }],
      port,
    );
    await getDb(ctx.db)
      .update(derivedRefreshWork)
      .set({ state: "completed", publishing: true });
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
    const subject = await createProductFixture(
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
    await refreshEntityEmbeddings(ctx.db, [ref], port);
    await refreshEntityEmbeddings(ctx.db, [ref], port);
    await refreshEntityEmbeddings(ctx.db, [ref], port);
    expect(calls).toBe(3);
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic unrelated embedding input" }),
      ctx.actor,
    );
    const stopped = await refreshEntityEmbeddings(ctx.db, [ref], port);
    expect(
      stopped.get(entityRefKey(ref.entityKind, ref.entityId)),
    ).toMatchObject({ exhausted: true });
    expect(calls).toBe(3);
    await renameFixtureRaw(
      ctx.db,
      "product",
      subject.entityId,
      "Synthetic changed embedding input",
    );
    await refreshEntityEmbeddings(ctx.db, [ref], port);
    expect(calls).toBe(4);
  });
});
