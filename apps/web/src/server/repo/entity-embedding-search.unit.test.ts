import { testEntityId } from "@cubby/schemas/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import {
  createInMemoryVectorizeIndex,
  productionVectorStore,
} from "~/server/semantic/vector-store";

import { findSimilarEntities } from "./entity-embedding-search";

afterEach(() => setCfEnv(undefined));

const vector = (lead: number, dimensions = 4): number[] =>
  Array.from({ length: dimensions }, (_, index) => (index === 0 ? lead : 0));

describe("findSimilarEntities", () => {
  it("excludes the seed itself and respects the limit against the real Vectorize surface", async () => {
    const index = createInMemoryVectorizeIndex();
    setCfEnv(fromPartial<Env>({ VECTORIZE: index }));

    const seed = {
      entityType: "recipe" as const,
      entityId: testEntityId("recipe", "seed"),
    };
    const neighbors = [
      testEntityId("recipe", "a"),
      testEntityId("recipe", "b"),
      testEntityId("recipe", "c"),
    ];

    await index.upsert([
      {
        id: `${seed.entityType}:${seed.entityId}`,
        values: vector(1),
        metadata: { entityType: seed.entityType },
      },
      ...neighbors.map((entityId, position) => ({
        id: `recipe:${entityId}`,
        // Decreasing similarity to the seed so ranking is deterministic.
        values: vector(1 - (position + 1) * 0.1),
        metadata: { entityType: "recipe" },
      })),
    ]);

    const results = await findSimilarEntities(productionVectorStore, seed, {
      targetType: "recipe",
      limit: 2,
    });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.entityId)).not.toContain(seed.entityId);
    expect(results.map((r) => r.entityId)).toEqual([
      neighbors[0],
      neighbors[1],
    ]);
  });

  it("returns no results when the seed has never been embedded", async () => {
    const index = createInMemoryVectorizeIndex();
    setCfEnv(fromPartial<Env>({ VECTORIZE: index }));

    const results = await findSimilarEntities(
      productionVectorStore,
      { entityType: "recipe", entityId: testEntityId("recipe", "unembedded") },
      { targetType: "recipe", limit: 5 },
    );

    expect(results).toEqual([]);
  });
});
