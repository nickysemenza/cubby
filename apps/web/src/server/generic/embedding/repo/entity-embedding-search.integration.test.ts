import { entityRefKey } from "@cubby/schemas/entity";
import { fromPartial } from "@total-typescript/shoehorn";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { seedEntityEmbedding } from "~/server/generic/embedding/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  createInMemoryVectorizeIndex,
  productionVectorStore,
} from "~/server/generic/embedding/service/semantic/vector-store";
import {
  refreshSearchDocument,
  getSearchDocumentEmbeddingText,
} from "~/server/generic/search/repo/search-document";
import { findRelatedSearchCandidates } from "~/server/generic/search/service/search.service";
import {
  createProductFixture,
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { settleEmbeddingProjectionJobs } from "./embedding-drain.fixtures";
import {
  findSemanticEntityCandidates,
  findSimilarEntities,
  findSimilarEntitiesPage,
  getEntityEmbeddingReadiness,
} from "./entity-embedding-search";

describe("validated semantic candidates", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  it("withholds completeness for documents missed while providers were unavailable without discarding valid positives", async () => {
    const index = createInMemoryVectorizeIndex();
    setCfEnv(
      fromPartial<Env>({
        VECTORIZE: index,
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
      }),
    );
    const config = getSemanticEmbeddingConfig();
    const values = Array.from({ length: config.dimensions }, (_, axis) =>
      axis === 0 ? 1 : 0,
    );
    const subjects = [];
    for (const name of [
      "Synthetic indexed candidate",
      "Synthetic formerly unconfigured candidate",
    ]) {
      const subject = await createProductFixture(
        ctx.db,
        makeProductInput({ name }),
        ctx.actor,
      );
      await refreshSearchDocument(ctx.db, "product", subject.entityId);
      const text = await getSearchDocumentEmbeddingText(
        ctx.db,
        "product",
        subject.entityId,
      );
      if (!text) throw new Error("Synthetic candidate projection missing");
      subjects.push({ subject, text });
    }
    const first = subjects[0];
    const second = subjects[1];
    if (!first || !second) throw new Error("Synthetic corpus missing");
    const seed = async (text: typeof first.text) => {
      const id = await seedEntityEmbedding(ctx.db, { ...text, config, values });
      await index.upsert([{ id, values, metadata: { entityType: "product" } }]);
    };
    await seed(first.text);
    await settleEmbeddingProjectionJobs(ctx.db);
    const incomplete = await findSemanticEntityCandidates(
      ctx.db,
      productionVectorStore,
      values,
      { entityKinds: ["product"], limit: 5, config },
    );
    expect(
      incomplete.candidates.map((candidate) => candidate.entityId),
    ).toEqual([first.subject.entityId]);
    expect(incomplete.complete).toBe(false);
    await seed(second.text);
    expect(
      (
        await findSemanticEntityCandidates(
          ctx.db,
          productionVectorStore,
          values,
          { entityKinds: ["product"], limit: 5, config },
        )
      ).complete,
    ).toBe(true);
    await getDb(ctx.db).execute(
      sql`SELECT derived_mark('product.searchDocument', ARRAY[${first.subject.entityId}::uuid])`,
    );
    const degraded = await findSemanticEntityCandidates(
      ctx.db,
      productionVectorStore,
      values,
      { entityKinds: ["product"], limit: 5, config },
    );
    expect(
      degraded.candidates.map((candidate) => candidate.entityId),
    ).toContain(first.subject.entityId);
    expect(degraded.complete).toBe(false);
    const ref = {
      entityKind: "product",
      entityId: first.subject.entityId,
    } as const;
    expect(await getEntityEmbeddingReadiness(ctx.db, ref, config)).toBe(
      "ready",
    );
    const similar = await findSimilarEntities(
      ctx.db,
      productionVectorStore,
      ref,
      { targetType: "product", limit: 5, config },
    );
    expect(similar.candidates.map((candidate) => candidate.entityId)).toContain(
      second.subject.entityId,
    );
    expect(similar.complete).toBe(false);
  });

  it("validates the seed and excludes it before trimming ranked neighbors", async () => {
    const index = createInMemoryVectorizeIndex();
    setCfEnv(
      fromPartial<Env>({
        VECTORIZE: index,
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
      }),
    );
    const config = getSemanticEmbeddingConfig();
    const seeded = [];
    for (let position = 0; position < 4; position++) {
      const entity = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: `Synthetic ranked candidate ${position}` }),
        ctx.actor,
      );
      await refreshSearchDocument(ctx.db, "product", entity.entityId);
      const text = await getSearchDocumentEmbeddingText(
        ctx.db,
        "product",
        entity.entityId,
      );
      if (!text) throw new Error("Synthetic search document missing");
      const values = Array.from({ length: config.dimensions }, (_, axis) =>
        axis === 0 ? 1 - position * 0.1 : axis === 1 ? position * 0.1 : 0,
      );
      const id = await seedEntityEmbedding(ctx.db, { ...text, config, values });
      await index.upsert([{ id, values, metadata: { entityType: "product" } }]);
      seeded.push({
        entityKind: "product" as const,
        entityId: entity.entityId,
      });
    }
    await settleEmbeddingProjectionJobs(ctx.db);
    const seed = seeded[0];
    if (!seed) throw new Error("Synthetic seed missing");
    const scans = await findSimilarEntitiesPage(
      ctx.db,
      productionVectorStore,
      seeded.slice(0, 2),
      { targetType: "product", limit: 2, config },
    );
    const first = scans.get(entityRefKey(seed.entityKind, seed.entityId));
    if (first?.status !== "fulfilled")
      throw new Error("Synthetic seed scan failed");
    const result = first.value;
    expect(result.complete).toBe(true);
    expect(result.candidates.map((row) => row.entityId)).toEqual(
      seeded.slice(1, 3).map((row) => row.entityId),
    );
    const secondSeed = seeded[1];
    if (!secondSeed) throw new Error("Synthetic sibling seed missing");
    const second = scans.get(
      entityRefKey(secondSeed.entityKind, secondSeed.entityId),
    );
    if (second?.status !== "fulfilled")
      throw new Error("Synthetic sibling scan failed");
    expect(second.value.complete).toBe(true);
    expect(second.value.candidates.map((row) => row.entityId)).toEqual([
      seeded[0]?.entityId,
      seeded[2]?.entityId,
    ]);
  });

  it("drops a stale vector whose entity no longer hydrates instead of surfacing a ghost hit", async () => {
    const index = createInMemoryVectorizeIndex();
    setCfEnv(
      fromPartial<Env>({
        VECTORIZE: index,
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
      }),
    );
    const config = getSemanticEmbeddingConfig();
    const entity = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic live semantic hit" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", entity.entityId);
    const text = await getSearchDocumentEmbeddingText(
      ctx.db,
      "product",
      entity.entityId,
    );
    if (!text) throw new Error("Synthetic semantic projection missing");
    const values = Array.from({ length: config.dimensions }, (_, axis) =>
      axis === 0 ? 1 : 0,
    );
    const id = await seedEntityEmbedding(ctx.db, { ...text, config, values });
    await index.upsert(
      [id, crypto.randomUUID()].map((id) => ({
        id,
        values,
        metadata: { entityType: "product" },
      })),
    );
    await settleEmbeddingProjectionJobs(ctx.db);
    const result = await findRelatedSearchCandidates(
      ctx.db,
      { query: "Synthetic semantic hit", limit: 5 },
      {
        configured: () => true,
        embed: async () => values,
        vectorStore: productionVectorStore,
      },
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready")
      throw new Error("Synthetic search not ready");
    expect(result.results.map((row) => row.entityId)).toEqual([
      entity.entityId,
    ]);
  });

  it("reports incomplete when the seed has never been embedded", async () => {
    const entity = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic missing seed" }),
      ctx.actor,
    );
    const result = await findSimilarEntities(
      ctx.db,
      productionVectorStore,
      { entityKind: "product", entityId: entity.entityId },
      { targetType: "product", limit: 5, config: getSemanticEmbeddingConfig() },
    );
    expect(result).toEqual({ candidates: [], complete: false });
  });
});
