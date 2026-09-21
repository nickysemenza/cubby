import { describe, expect, it } from "vitest";

import { assertDistinctMergeTargets } from "./core";

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
