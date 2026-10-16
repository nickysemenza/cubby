import { describe, expect, it } from "vitest";

import { loadPhotoRunCandidateChunks } from "./photo-run-candidates";

describe("photo Run candidate chunks", () => {
  // Every group remains visible when independent invocations finish out of order or fail.
  it("requests chunks concurrently and merges ready and failed groups", async () => {
    const groupKeys = Array.from(
      { length: 14 },
      (_, index) => `group-${index}`,
    );
    const requests: string[][] = [];
    const result = await loadPhotoRunCandidateChunks(
      groupKeys,
      async (keys) => {
        requests.push(keys);
        await Promise.resolve();
        if (keys.includes("group-6"))
          throw new Error("Synthetic inference failure");
        return {
          groups: keys.map((groupKey) => ({
            groupKey,
            status: "ready" as const,
            error: null,
            candidates: [],
            rejectedCandidates: [],
            selectedComparison: null,
          })),
        };
      },
    );
    expect(requests.map((keys) => keys.length)).toEqual([6, 6, 2]);
    expect(result.groups.map((group) => group.groupKey)).toEqual(groupKeys);
    expect(
      result.groups.filter((group) => group.status === "ready"),
    ).toHaveLength(8);
    expect(
      result.groups.filter((group) => group.status === "failed"),
    ).toHaveLength(6);
    expect(result.groups[6]?.error).toBe("Synthetic inference failure");
  });
});
