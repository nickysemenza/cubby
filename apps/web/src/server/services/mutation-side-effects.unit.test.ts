import { describe, expect, it } from "vitest";
import {
  mutationSideEffectEventSchema,
  mutationSideEffectManifest,
} from "./mutation-side-effects";

describe("mutation side effects manifest", () => {
  it("parses typed mutation entity refs", () => {
    const parsed = mutationSideEffectEventSchema.parse({
      action: "updated",
      entity: {
        entityType: "product",
        entityId: "00000000-0000-4000-8000-000000000001",
      },
      source: "test.product",
    });

    expect(parsed).toMatchObject({
      action: "updated",
      entity: { entityType: "product" },
      source: "test.product",
    });
  });

  it("rejects mismatched entity ids", () => {
    expect(() =>
      mutationSideEffectEventSchema.parse({
        action: "updated",
        entity: { entityType: "product", entityId: "not-a-uuid" },
        source: "test.product",
      }),
    ).toThrow();
  });

  it("declares create update and delete hooks for every supported entity", () => {
    expect(Object.keys(mutationSideEffectManifest).sort()).toEqual([
      "image",
      "ingredient",
      "inventory",
      "location",
      "product",
      "recipe",
    ]);
    for (const handlers of Object.values(mutationSideEffectManifest)) {
      expect(handlers).toHaveProperty("onCreate");
      expect(handlers).toHaveProperty("onUpdate");
      expect(handlers).toHaveProperty("onDelete");
    }
  });
});
