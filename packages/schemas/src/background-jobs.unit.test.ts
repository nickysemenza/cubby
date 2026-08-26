import { describe, expect, expectTypeOf, it } from "vitest";
import {
  backgroundJobPayloadSchema,
  entityEmbeddingBackfillCoordinatorPayloadSchema,
} from "./background-jobs";
import type { ProductId, RecipeId } from "./identifiers";
import { testEntityId } from "./test-support/identifiers";

describe("background job identifier parsing", () => {
  it("brands recipe ids at the persisted-payload seam", () => {
    const recipeId = testEntityId("recipe", "totals");
    const parsed = backgroundJobPayloadSchema.parse({
      kind: "recipe-totals.recompute",
      payload: { recipeIds: [recipeId] },
    });

    if (parsed.kind !== "recipe-totals.recompute") throw new Error("wrong job");
    expectTypeOf(parsed.payload.recipeIds).toEqualTypeOf<RecipeId[]>();
    expect(parsed.payload.recipeIds).toEqual([recipeId]);
  });

  it("produces one correlated entity reference for embedding work", () => {
    const entityId = testEntityId("product", "embedding");
    const parsed = backgroundJobPayloadSchema.parse({
      kind: "entity-embedding.refresh",
      payload: { entityType: "product", entityId },
    });

    if (parsed.kind !== "entity-embedding.refresh")
      throw new Error("wrong job");
    if (parsed.payload.ref.entity !== "product")
      throw new Error("wrong entity");
    expectTypeOf(parsed.payload.ref.id).toEqualTypeOf<ProductId>();
    expect(parsed.payload.ref).toEqual({ entity: "product", id: entityId });
  });

  it("brands workflow cursor ids and rejects malformed payload ids", () => {
    const entityId = testEntityId("product", "cursor");
    const parsed = entityEmbeddingBackfillCoordinatorPayloadSchema.parse({
      source: "search.debug.semanticBackfill",
      workflow: {
        type: "entity-embedding.backfill.coordinator",
        entityTypes: ["product"],
        cursor: { entityType: "product", entityId },
        pagesCompleted: 1,
        jobsQueued: 1,
        state: "active",
      },
    });

    expect(parsed.workflow.cursor?.ref).toEqual({
      entity: "product",
      id: entityId,
    });
    expect(() =>
      backgroundJobPayloadSchema.parse({
        kind: "location-ai.description.refresh",
        payload: { locationId: "not-a-uuid" },
      }),
    ).toThrow();
  });
});
