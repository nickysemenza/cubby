import { describe, expect, it } from "vitest";
import { summarizeChanges } from "./audit-log-entry";

/**
 * The home feed renders one line per audit entry, so `summarizeChanges` is a
 * lossy projection of the full diff. Its `omitted` count is the only thing
 * telling the reader that, which makes under-counting worse than showing
 * nothing: a row that quietly reports fewer changes than it made is a claim,
 * not an omission.
 */
describe("summarizeChanges", () => {
  it("counts fields it cannot render toward the omitted disclosure", () => {
    // The regression: unrenderable fields were filtered out *before* `omitted`
    // was computed, so they landed in neither the line nor the "+N". Object
    // diffs are exactly what a recompute-style update touches, so a row could
    // change three fields, render one, and disclose nothing.
    const summary = summarizeChanges({
      name: { from: "Old", to: "New" },
      totals: { from: { cost: 1 }, to: { cost: 2 } },
      valuation: { from: { total: 3 }, to: { total: 4 } },
    });

    expect(summary?.shown.map((f) => f.field)).toEqual(["name"]);
    expect(summary?.omitted).toBe(2);
  });

  it("ranks low-signal fields last, and counts the ones it drops", () => {
    const summary = summarizeChanges({
      updatedAt: { from: "2026-01-01", to: "2026-01-02" },
      quantity: { from: 3, to: 1 },
      placement: { from: "stock", to: "installed" },
    });

    expect(summary?.shown.map((f) => f.field)).toEqual([
      "quantity",
      "placement",
    ]);
    expect(summary?.omitted).toBe(1);
  });

  it("renders a field that is newly set, where only one side has a value", () => {
    const summary = summarizeChanges({ name: { from: null, to: "Named" } });

    expect(summary?.shown[0]?.from).toBeNull();
    expect(summary?.shown[0]?.to?.text).toBe("Named");
    expect(summary?.omitted).toBe(0);
  });

  it("falls back to null when nothing in the diff can be rendered", () => {
    // Better the caller shows its verb badge than a bare "+2" naming no field.
    expect(
      summarizeChanges({
        totals: { from: { cost: 1 }, to: { cost: 2 } },
        embedding: { from: { v: [1] }, to: { v: [2] } },
      }),
    ).toBeNull();
  });

  it("returns null for an entry with no changes at all", () => {
    expect(summarizeChanges(null)).toBeNull();
    expect(summarizeChanges({})).toBeNull();
  });
});
