import { describe, expect, it } from "vitest";

import {
  assertDistinctMergeTargets,
  mergeNotes,
  suggestMergeSurvivor,
} from "./core";

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

describe("suggestMergeSurvivor", () => {
  it("prefers most connections, then the oldest, then the lowest code", () => {
    const candidate = (
      id: string,
      connectionCount: number,
      createdAt: string,
    ) => ({
      id,
      connectionCount,
      createdAt,
    });
    expect(
      suggestMergeSurvivor([
        candidate("VEN-OLD", 1, "2024-01-01T00:00:00.000Z"),
        candidate("VEN-BUSY", 4, "2025-06-01T00:00:00.000Z"),
      ])?.id,
    ).toBe("VEN-BUSY");
    expect(
      suggestMergeSurvivor([
        candidate("VEN-NEW", 2, "2025-06-01T00:00:00.000Z"),
        candidate("VEN-OLD", 2, "2024-01-01T00:00:00.000Z"),
      ])?.id,
    ).toBe("VEN-OLD");
    expect(
      suggestMergeSurvivor([
        candidate("VEN-B", 0, "2024-01-01T00:00:00.000Z"),
        candidate("VEN-A", 0, "2024-01-01T00:00:00.000Z"),
      ])?.id,
    ).toBe("VEN-A");
  });
});
