import { describe, expect, it } from "vitest";

import { assertDistinctMergeTargets, mergeNotes } from "./core";

describe("mergeNotes", () => {
  it("preserves original whitespace and removes only exact duplicate texts", () => {
    expect(
      mergeNotes(null, "", "  First\n", "Second  ", "  First\n", "Second"),
    ).toBe("  First\n\n\nSecond  \n\nSecond");
    expect(mergeNotes(null, "")).toBeNull();
    expect(mergeNotes("  ", null)).toBe("  ");
  });
});

describe("assertDistinctMergeTargets", () => {
  it("accepts a keeper distinct from every merge target", () => {
    expect(() =>
      assertDistinctMergeTargets("ingredient", "ING-KEEP", [
        "ING-LOSE",
        "ING-OTHER",
      ]),
    ).not.toThrow();
  });

  it("rejects naming the keeper anywhere among the merge targets", () => {
    let error: unknown;
    try {
      assertDistinctMergeTargets("ingredient", "ING-KEEP", [
        "ING-LOSE",
        "ING-KEEP",
        "ING-KEEP",
      ]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      reason: "MERGE_SELF_REFERENCE",
    });
  });
});
