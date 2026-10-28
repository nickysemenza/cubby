import { describe, expect, it } from "vitest";

import { decideReadConsistency } from "./read-consistency";

describe("member read consistency", () => {
  it("allows browser display reads without writes but requires a marker for API clients", () => {
    const base = {
      boundedStaleAvailable: true,
      marker: { kind: "absent" } as const,
    };
    expect(decideReadConsistency({ ...base, browser: true }).consistency).toBe(
      "bounded-stale",
    );
    expect(decideReadConsistency({ ...base, browser: false }).reason).toBe(
      "marker-required",
    );
  });
  it("keeps this member strong through the full bounded-stale window", () => {
    for (const browser of [true, false]) {
      const base = {
        boundedStaleAvailable: true,
        browser,
        marker: { kind: "valid", lastWriteAt: 1000 } as const,
      };
      expect(decideReadConsistency({ ...base, now: 90000 }).reason).toBe(
        "fresh-after-write",
      );
      expect(decideReadConsistency({ ...base, now: 91000 }).consistency).toBe(
        "bounded-stale",
      );
      expect(
        decideReadConsistency({ ...base, now: 91000, forceStrong: true })
          .reason,
      ).toBe("invalidation-refetch");
    }
  });
  it("fails closed for malformed markers and unavailable cache bindings", () => {
    expect(
      decideReadConsistency({
        boundedStaleAvailable: true,
        browser: true,
        marker: { kind: "invalid" },
      }).reason,
    ).toBe("invalid-marker");
    expect(
      decideReadConsistency({
        boundedStaleAvailable: false,
        browser: true,
        marker: { kind: "absent" },
      }).reason,
    ).toBe("single-database");
  });
});
