import { describe, expect, it } from "vitest";
import {
  collectionSlugsFromTags,
  isCollectionTag,
  normalizeCollectionSlug,
  setCollectionTag,
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
});
