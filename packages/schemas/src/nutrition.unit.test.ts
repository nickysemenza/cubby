import { describe, expect, it } from "vitest";
import {
  buildNutrition,
  estimateCoverage,
  measureEstimate,
  nutritionTotals,
} from "./nutrition";
import { TIER1_NUTRIENT_KEYS } from "@cubby/usda-schemas";

describe("nutrition estimate contract", () => {
  it("preserves known zero and distinguishes unavailable nutrients", () => {
    const nutrition = buildNutrition((key) =>
      key === "protein"
        ? {
            status: "complete",
            lower: 0,
            upper: null,
            coverage: { covered: 1, total: 1 },
          }
        : { status: "unavailable", reason: "no_data" },
    );
    expect(nutrition.protein).toMatchObject({ status: "complete", lower: 0 });
    expect(nutrition.fat).toEqual({ status: "unavailable", reason: "no_data" });
    expect(Object.keys(nutrition).sort()).toEqual(
      [...TIER1_NUTRIENT_KEYS].sort(),
    );
  });

  it("rejects impossible ranges and coverage", () => {
    expect(
      measureEstimate.safeParse({
        status: "partial",
        lower: 8,
        upper: 5,
        coverage: { covered: 1, total: 2 },
      }).success,
    ).toBe(false);
    expect(
      measureEstimate.safeParse({
        status: "complete",
        lower: 0,
        upper: null,
        coverage: { covered: 3, total: 2 },
      }).success,
    ).toBe(false);
  });

  it("round-trips zero coverage on unavailable estimates", () => {
    const withCoverage = {
      status: "unavailable",
      reason: "no_data",
      coverage: { covered: 0, total: 3 },
    } as const;
    expect(measureEstimate.parse(withCoverage)).toEqual(withCoverage);
    expect(estimateCoverage(withCoverage)).toEqual({ covered: 0, total: 3 });
    expect(
      measureEstimate.safeParse({
        status: "unavailable",
        reason: "no_data",
        coverage: { covered: 1, total: 3 },
      }).success,
    ).toBe(false);
    // Rows persisted before `coverage` existed still parse and report no count.
    const legacy = { status: "unavailable", reason: "no_data" } as const;
    expect(measureEstimate.parse(legacy)).toEqual(legacy);
    expect(estimateCoverage(legacy)).toBeUndefined();
    expect(
      estimateCoverage({ status: "pending", reason: "totals_stale" }),
    ).toBeUndefined();
  });

  it("requires the canonical shape and the full catalog", () => {
    expect(
      nutritionTotals.safeParse({ costTotal: 4, caloriesTotal: 80 }).success,
    ).toBe(false);
    expect(
      nutritionTotals.safeParse({
        cost: { status: "pending", reason: "totals_missing" },
        nutrition: {},
      }).success,
    ).toBe(false);
  });
});
