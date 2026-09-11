import { describe, expect, it } from "vitest";
import { buildNutrition, measureEstimate, nutritionTotals } from "./nutrition";
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
