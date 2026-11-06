import type { SimilarEntitiesOut } from "@cubby/schemas/search";
import { searchHitSchema } from "@cubby/schemas/search";
import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";

type RelatednessDependencies = NonNullable<
  Parameters<typeof getEntityRelatedness>[2]
>;
import { getEntityRelatedness } from "./relatedness.service";

const sourceId = testShortcode("recipe", "RCP-ABCD");
const scoreId = testShortcode("recipe", "score");
const hiddenId = testShortcode("recipe", "hidden");
const dependencyOnlyDatabase = createDatabase(() => {
  throw new Error("Relatedness unit dependencies must not resolve a database");
});

const searchHit = (id: string, title: string) =>
  searchHitSchema.parse({
    id,
    entityKind: "recipe",
    title,
    subtitle: null,
    typeHint: null,
    imageUrl: null,
    matchKind: "semantic",
    matchField: "title",
    matchReason: "test fixture",
    matchTerms: [],
  });

function dependenciesFor(
  overrides: Partial<RelatednessDependencies> = {},
): RelatednessDependencies {
  const dependencies: RelatednessDependencies = {
    resolveOrThrow: async (_db, entity) => testEntityId(entity, "source"),
    findSemanticNeighbours: async () => ({
      source: { entityKind: "recipe", entityId: sourceId },
      status: "ready",
      complete: true,
      results: [],
    }),
    readScalarOverlaps: async () => [],
    hydrateSearchHitRefs: async () => [],
  };
  return { ...dependencies, ...overrides };
}

describe("getEntityRelatedness", () => {
  it("retains flat merged evidence and scalar-only records", async () => {
    const dependencies = dependenciesFor({
      findSemanticNeighbours: async (): Promise<SimilarEntitiesOut> => ({
        source: { entityKind: "recipe", entityId: sourceId },
        status: "ready",
        complete: true,
        results: [
          {
            similarity: 0.9,
            entity: searchHit(scoreId, "Scored recipe"),
          },
        ],
      }),
      readScalarOverlaps: async () => [
        { entityId: testEntityId("recipe", "score"), values: ["useful"] },
        { entityId: testEntityId("recipe", "hidden"), values: ["old"] },
      ],
      hydrateSearchHitRefs: async () => [
        {
          ...searchHit(scoreId, "Scored recipe"),
          entityId: testEntityId("recipe", "score"),
        },
        {
          ...searchHit(hiddenId, "Tag-only recipe"),
          entityId: testEntityId("recipe", "hidden"),
        },
      ],
    });

    await expect(
      getEntityRelatedness(
        dependencyOnlyDatabase,
        { entity: "recipe", id: sourceId },
        dependencies,
      ),
    ).resolves.toMatchObject({
      status: "ready",
      items: [
        {
          shortcode: scoreId,
          score: 0.9,
          evidence: [{ signal: "Similar meaning" }, { signal: "Shared tag" }],
        },
        { shortcode: hiddenId, score: 0, evidence: [{ signal: "Shared tag" }] },
      ],
    });
  });
});
