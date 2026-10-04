import { describe, expect, it } from "vitest";
import vectors from "../golden-vectors/collection-tag.json";
import {
  collectionSlugsFromTags,
  isCollectionTag,
  mergeProductTags,
  normalizeCollectionSlug,
  setCollectionTag,
  splitProductTags,
} from "./collection-tag";

describe("Collection tags", () => {
  it("recognizes only valid namespaced slugs", () => {
    expect(isCollectionTag("collection:metal-working")).toBe(true);
    expect(isCollectionTag("M18")).toBe(false);
    expect(isCollectionTag("collection:Metal Working")).toBe(false);
  });

  it("normalizes labels and deduplicates collection membership", () => {
    expect(normalizeCollectionSlug("  Metal Working! ")).toBe("metal-working");
    expect(
      collectionSlugsFromTags([
        "collection:painting",
        "M18",
        "collection:painting",
      ]),
    ).toEqual(["painting"]);
  });

  it("sets membership idempotently without changing compatibility tags", () => {
    expect(setCollectionTag(["M18"], "painting", true)).toEqual([
      "M18",
      "collection:painting",
    ]);
    expect(
      setCollectionTag(["M18", "collection:painting"], "painting", false),
    ).toEqual(["M18"]);
  });

  // Shared with CubbyKit's CollectionTagTests: native applies the same rule.
  it("splits and merges a product's tags exactly as the shared vectors say", () => {
    for (const vector of vectors.split)
      expect(splitProductTags(vector.tags)).toEqual({
        tags: vector.tagsOut,
        collections: vector.collections,
      });
    for (const vector of vectors.merge)
      expect(mergeProductTags(vector.tags, vector.collections)).toEqual(
        vector.out,
      );
    for (const vector of vectors.normalize)
      expect(normalizeCollectionSlug(vector.in)).toBe(vector.out);
  });
});
