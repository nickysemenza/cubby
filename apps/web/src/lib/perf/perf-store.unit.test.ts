import { beforeEach, describe, expect, it } from "vitest";
import {
  recordCommandSearch,
  recordNavigation,
  reset,
  snapshot,
} from "./perf-store";

describe("interaction performance records", () => {
  beforeEach(() => reset());

  it("keeps bounded navigation and Command-K samples", () => {
    for (let index = 0; index < 60; index += 1) {
      recordNavigation({
        routeId: `/route-${index}`,
        durationMs: index,
        pendingShown: index % 2 === 0,
      });
      recordCommandSearch({
        phase: "lexical",
        durationMs: index,
        resultCount: 1,
        scoped: false,
        queryLength: 4,
      });
    }

    const current = snapshot();
    expect(current.navigation.records).toHaveLength(50);
    expect(current.navigation.records[0]?.routeId).toBe("/route-10");
    expect(current.commandSearch.records).toHaveLength(50);
    expect(current.commandSearch.records.at(-1)?.durationMs).toBe(59);
  });
});
