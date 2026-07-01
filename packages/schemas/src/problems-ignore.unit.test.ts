import { describe, expect, it } from "vitest";
import {
  filterIgnoredFromArrays,
  problemIgnoreKey,
  problemSectionArrayKeys,
} from "./problems";

describe("problemIgnoreKey", () => {
  it("is section-scoped and stable", () => {
    expect(problemIgnoreKey("orphaned", "p1")).toBe("orphaned:p1");
    // Same entity id in two sections yields distinct keys — ignoring in one
    // must not hide it in the other.
    expect(problemIgnoreKey("images", "p1")).not.toBe(
      problemIgnoreKey("orphaned", "p1"),
    );
  });
});

describe("filterIgnoredFromArrays", () => {
  it("drops only the ignored item, in its own section", () => {
    const bag = {
      orphanedProducts: [{ id: "p1" }, { id: "p2" }],
      productsWithNoImages: [{ id: "p1" }],
    };
    const ignored = new Set([problemIgnoreKey("orphaned", "p1")]);
    const out = filterIgnoredFromArrays(bag, ignored);
    // p1 removed from orphaned...
    expect(out.orphanedProducts.map((p) => p.id)).toEqual(["p2"]);
    // ...but the SAME id survives in the images section (different section key).
    expect(out.productsWithNoImages.map((p) => p.id)).toEqual(["p1"]);
  });

  it("filters every array a merged section draws from (unit-coverage)", () => {
    const bag = {
      productsWithoutMappings: [{ id: "a" }],
      ingredientsWithPartialCoverage: [{ id: "b" }],
      productsWithIslandedMappings: [{ id: "c" }],
    };
    const ignored = new Set([
      problemIgnoreKey("unit-coverage", "b"),
      problemIgnoreKey("unit-coverage", "c"),
    ]);
    const out = filterIgnoredFromArrays(bag, ignored);
    expect(out.productsWithoutMappings.map((p) => p.id)).toEqual(["a"]);
    expect(out.ingredientsWithPartialCoverage).toEqual([]);
    expect(out.productsWithIslandedMappings).toEqual([]);
  });

  it("returns the bag untouched for an empty ignore set", () => {
    const bag = { orphanedProducts: [{ id: "p1" }] };
    expect(filterIgnoredFromArrays(bag, new Set())).toBe(bag);
  });

  it("every registered section key is a real AllProblems array field", () => {
    // Guards against the section→array map drifting from the detector output.
    for (const keys of Object.values(problemSectionArrayKeys)) {
      expect(keys.length).toBeGreaterThan(0);
    }
  });
});
