import { describe, expect, it } from "vitest";

import { databaseFreshness } from "./database-freshness/state";
import { decideReadConsistency } from "./read-consistency";

describe("shared read consistency", () => {
  it("uses cached reads after the household deadline expires", () => {
    expect(
      decideReadConsistency({
        boundedStaleAvailable: true,
        freshness: databaseFreshness(1000),
        now: 91000,
      }),
    ).toEqual({ consistency: "bounded-stale", reason: "cached-policy" });
  });
  it("keeps every client strong immediately after any household write", () => {
    for (const now of [1000, 90000])
      expect(
        decideReadConsistency({
          boundedStaleAvailable: true,
          freshness: databaseFreshness(1000),
          now,
        }).consistency,
      ).toBe("strong");
  });
  it("fails closed when freshness or the cached binding is unavailable", () => {
    expect(
      decideReadConsistency({ boundedStaleAvailable: true, freshness: null })
        .reason,
    ).toBe("freshness-unavailable");
    expect(
      decideReadConsistency({
        boundedStaleAvailable: false,
        freshness: databaseFreshness(0),
      }).reason,
    ).toBe("single-database");
  });
});
