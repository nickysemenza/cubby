import {
  type RelatednessPair,
  relatednessPairRegistry,
} from "@cubby/schemas/relatedness";
import { similarEntityPairSchema } from "@cubby/schemas/search";
import { describe, expect, it } from "vitest";

describe("relatedness pair registry", () => {
  it("exposes only independently activated pairs to public semantic search", () => {
    for (const [key, pair] of Object.entries(relatednessPairRegistry) as [
      RelatednessPair,
      (typeof relatednessPairRegistry)[RelatednessPair],
    ][]) {
      expect(similarEntityPairSchema.safeParse(key).success).toBe(pair.active);
    }
  });
});
