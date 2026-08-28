import type { SimilarEntitiesOut } from "@cubby/schemas/search";
import { searchHitSchema } from "@cubby/schemas/search";
import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { RelatednessDependencies } from "./relatedness.service";
import {
  getProductRelatedness,
  getProductTagPropagation,
} from "./relatedness.service";

const sourceId = testShortcode("product", "PRD-ABCD");
const scoreId = testShortcode("product", "score");
const hiddenId = testShortcode("product", "hidden");
const oneId = testShortcode("product", "one");
const twoId = testShortcode("product", "two");
const threeId = testShortcode("product", "three");

const searchHit = (id: string, title: string) =>
  searchHitSchema.parse({
    id,
    entityType: "product",
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
    resolveSourceId: async () => testEntityId("product", "source"),
    findSimilarEntities: async () => ({
      source: { entityType: "product", entityId: sourceId },
      status: "ready",
      results: [],
    }),
    getProductsSharingTags: async () => [],
    getProductsByShortcodes: async () => [],
    getActiveDismissalKeys: async () => new Set(),
    makeCandidateKey: async (_kind, values) => `key:${values.join(":")}`,
  };
  return { ...dependencies, ...overrides };
}

describe("getProductRelatedness", () => {
  const ctx = withTestDb();

  it("suppresses dismissed candidates while retaining flat merged evidence", async () => {
    const dependencies = dependenciesFor({
      findSimilarEntities: async (): Promise<SimilarEntitiesOut> => ({
        source: { entityType: "product", entityId: sourceId },
        status: "ready",
        results: [
          {
            similarity: 0.9,
            entity: searchHit(scoreId, "Scored product"),
          },
        ],
      }),
      getProductsSharingTags: async () => [
        { shortcode: scoreId, name: "Scored product", tags: ["useful"] },
        { shortcode: hiddenId, name: "Hidden product", tags: ["old"] },
      ],
      getActiveDismissalKeys: async () => new Set([`key:${hiddenId}`]),
    });

    await expect(
      getProductRelatedness(ctx.db, sourceId, dependencies),
    ).resolves.toMatchObject({
      status: "ready",
      items: [
        {
          shortcode: scoreId,
          score: 0.9,
          evidence: [{ signal: "Similar meaning" }, { signal: "Shared tag" }],
        },
      ],
    });
  });
});

describe("getProductTagPropagation", () => {
  const ctx = withTestDb();

  it("proposes only non-collection tags with three semantic-neighbour votes", async () => {
    const dependencies = dependenciesFor({
      findSimilarEntities: async (): Promise<SimilarEntitiesOut> => ({
        source: { entityType: "product", entityId: sourceId },
        status: "ready",
        results: [
          { entity: searchHit(oneId, "One"), similarity: 0.9 },
          { entity: searchHit(twoId, "Two"), similarity: 0.8 },
          { entity: searchHit(threeId, "Three"), similarity: 0.7 },
        ],
      }),
      getActiveDismissalKeys: async () => new Set(),
      makeCandidateKey: async () => "candidate-key",
      getProductsByShortcodes: async () => [
        { id: sourceId, tags: ["already"] },
        { id: oneId, tags: ["shared", "collection:tools"] },
        { id: twoId, tags: ["shared"] },
        { id: threeId, tags: ["shared", "already"] },
      ],
    });

    await expect(
      getProductTagPropagation(ctx.db, sourceId, dependencies),
    ).resolves.toEqual({
      status: "ready",
      currentTags: ["already"],
      proposals: [{ tag: "shared", supportingProductCount: 3 }],
    });
  });
});
