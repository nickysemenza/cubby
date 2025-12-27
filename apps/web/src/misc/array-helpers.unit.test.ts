import { describe, expect, it } from "vitest";
import { dedupe } from "./array-helpers";

describe("dedupe", () => {
  it("should remove duplicate strings", () => {
    expect(dedupe(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("should remove duplicate numbers", () => {
    expect(dedupe([1, 2, 1, 3, 2])).toEqual([1, 2, 3]);
  });

  it("should handle empty array", () => {
    expect(dedupe([])).toEqual([]);
  });

  it("should handle array with no duplicates", () => {
    expect(dedupe([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("should handle array with all duplicates", () => {
    expect(dedupe([1, 1, 1, 1])).toEqual([1]);
  });
});
