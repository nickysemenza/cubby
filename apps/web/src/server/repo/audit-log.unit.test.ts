import { describe, expect, it } from "vitest";
import { diffUnorderedIdSet } from "~/server/repo/audit-log";

describe("diffUnorderedIdSet", () => {
  it("returns undefined when the sets are equal but reordered", () => {
    const result = diffUnorderedIdSet(["a", "b", "c"], ["c", "a", "b"]);
    expect(result).toBeUndefined();
  });

  it("returns undefined when both sets are empty", () => {
    const result = diffUnorderedIdSet([], []);
    expect(result).toBeUndefined();
  });

  it("detects an added id", () => {
    const result = diffUnorderedIdSet(["a"], ["a", "b"]);
    expect(result).toEqual({ from: ["a"], to: ["a", "b"] });
  });

  it("detects a removed id", () => {
    const result = diffUnorderedIdSet(["a", "b"], ["a"]);
    expect(result).toEqual({ from: ["a", "b"], to: ["a"] });
  });

  it("preserves the original (unsorted) order in the returned from/to", () => {
    const result = diffUnorderedIdSet(["b", "a"], ["a", "b", "c"]);
    expect(result).toEqual({ from: ["b", "a"], to: ["a", "b", "c"] });
  });
});
