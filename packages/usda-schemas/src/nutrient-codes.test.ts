import { describe, expect, it } from "vitest";
import { DAILY_VALUES, dailyValuePct, TIER1_NUTRIENTS } from "./nutrient-codes";

describe("dailyValuePct", () => {
  it("computes the FDA label percent for a nutrient amount", () => {
    // 18g fat against a 78g DV -> 23.07...%
    expect(dailyValuePct("fat", 18)).toBeCloseTo((18 / 78) * 100);
  });

  it("returns 100 when the amount equals the Daily Value", () => {
    expect(dailyValuePct("sodium", 2300)).toBeCloseTo(100);
  });

  it("returns 0 for a zero amount", () => {
    expect(dailyValuePct("protein", 0)).toBe(0);
  });

  it("has a Daily Value for every tier 1 nutrient key", () => {
    for (const key of Object.keys(TIER1_NUTRIENTS) as Array<
      keyof typeof TIER1_NUTRIENTS
    >) {
      expect(DAILY_VALUES[key]).toBeGreaterThan(0);
    }
  });
});
