import { describe, expect, it } from "vitest";

import {
  stableTargetRows,
  targetNeedsAttention,
  type RunTarget,
} from "./run-targets-model";

const target = (id: string, state = "pending"): RunTarget => ({
  id,
  targetType: "product",
  targetShortcode: "PRD_SYNTHETIC",
  targetName: "Example record",
  sourceId: null,
  sourceLabel: null,
  vendorAccountLabel: null,
  state,
  fingerprint: null,
  outcome: null,
  warning: null,
  diff: null,
  completedAt: null,
});

describe("Run target polling", () => {
  it("updates admitted rows in their original order and holds new arrivals", () => {
    const updated = target("first", "completed");
    expect(
      stableTargetRows(
        [target("new"), target("second"), updated],
        ["first", "second"],
      ),
    ).toEqual([updated, target("second")]);
  });
  it("removes erased evidence instead of retaining stale rows", () => {
    expect(stableTargetRows([], ["first"])).toEqual([]);
  });
  it("only offers attention for an unresolved target with a record link", () => {
    expect(targetNeedsAttention(target("first", "needs_evidence"))).toBe(true);
    expect(
      targetNeedsAttention({
        ...target("first", "unresolved"),
        targetShortcode: null,
      }),
    ).toBe(false);
    expect(targetNeedsAttention(target("first", "completed"))).toBe(false);
  });
});
