import { describe, expect, it } from "vitest";

import { costPerNutrient, proteinPer100Kcal } from "./nutrition-intel";

describe("costPerNutrient", () => {
  it("divides cost by nutrient amount", () => {
    expect(costPerNutrient(4, 20)).toBeCloseTo(0.2);
  });

  it("returns null for a null cost", () => {
    expect(costPerNutrient(null, 20)).toBeNull();
  });

  it("returns null for an undefined amount", () => {
    expect(costPerNutrient(4, undefined)).toBeNull();
  });

  it("returns null for a zero amount", () => {
    expect(costPerNutrient(4, 0)).toBeNull();
  });

  it("returns null for a negative amount", () => {
    expect(costPerNutrient(4, -5)).toBeNull();
  });

  it("returns null for a non-finite cost", () => {
    expect(costPerNutrient(Number.NaN, 20)).toBeNull();
    expect(costPerNutrient(Number.POSITIVE_INFINITY, 20)).toBeNull();
  });
});

describe("proteinPer100Kcal", () => {
  it("computes grams of protein per 100 kcal", () => {
    // 30g protein in a 600 kcal recipe -> 5g / 100 kcal
    expect(proteinPer100Kcal(30, 600)).toBeCloseTo(5);
  });

  it("returns null for a null protein value", () => {
    expect(proteinPer100Kcal(null, 600)).toBeNull();
  });

  it("returns null for an undefined kcal value", () => {
    expect(proteinPer100Kcal(30, undefined)).toBeNull();
  });

  it("returns null for a zero kcal value", () => {
    expect(proteinPer100Kcal(30, 0)).toBeNull();
  });

  it("returns null for a negative kcal value", () => {
    expect(proteinPer100Kcal(30, -100)).toBeNull();
  });
});
