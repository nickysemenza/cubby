import { describe, expect, it } from "vitest";

import { costPerNutrient, proteinPer100Kcal } from "./nutrition-intel";

describe("costPerNutrient", () => {
  it("divides cost by nutrient amount", () => {
    expect(costPerNutrient(4, 20)).toBeCloseTo(0.2);
  });

  it("returns null when cost or nutrient amount cannot make a ratio", () => {
    for (const [cost, amount] of [
      [null, 20],
      [4, undefined],
      [4, 0],
      [4, -5],
      [Number.NaN, 20],
      [Number.POSITIVE_INFINITY, 20],
    ] as const) {
      expect(costPerNutrient(cost, amount)).toBeNull();
    }
  });
});

describe("proteinPer100Kcal", () => {
  it("computes grams of protein per 100 kcal", () => {
    // 30g protein in a 600 kcal recipe -> 5g / 100 kcal
    expect(proteinPer100Kcal(30, 600)).toBeCloseTo(5);
  });

  it("returns null when protein or kcal cannot make a ratio", () => {
    for (const [protein, kcal] of [
      [null, 600],
      [30, undefined],
      [30, 0],
      [30, -100],
    ] as const) {
      expect(proteinPer100Kcal(protein, kcal)).toBeNull();
    }
  });
});
