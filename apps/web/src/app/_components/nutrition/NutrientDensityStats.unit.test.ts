import { manualUnitMapping } from "@cubby/schemas/unitmapping";
import { buildNutrients } from "@cubby/usda-schemas";
import { describe, expect, it } from "vitest";

import {
  computeNutrientDensityFigures,
  resolveBasisAmountPerEach,
} from "./NutrientDensityStats";

// "1 each = 500 g" — the shape a stored product weight mapping takes in the
// unit graph (same edge resolveServingBasis / ProductNutritionLabel read).
const weightMapping = manualUnitMapping(
  { value: 1, unit: "each" },
  { value: 500, unit: "g" },
);

// "1 each = 750 ml" — the volume analogue for an mL-serving branded food
// whose USDA nutrient record is stated per 100 mL, not per 100 g.
const volumeMapping = manualUnitMapping(
  { value: 1, unit: "each" },
  { value: 750, unit: "ml" },
);

describe("resolveBasisAmountPerEach", () => {
  it("resolves grams-per-each from a stored weight mapping", () => {
    expect(resolveBasisAmountPerEach([weightMapping], "g")).toBe(500);
  });

  it("resolves mL-per-each from a stored volume mapping when the basis is ml", () => {
    expect(resolveBasisAmountPerEach([volumeMapping], "ml")).toBe(750);
  });

  it("returns null when no mapping resolves an each-to-basis edge", () => {
    expect(resolveBasisAmountPerEach([], "g")).toBeNull();
  });

  it("returns null for a mapping that doesn't reach the basis kind (e.g. price only)", () => {
    const priceOnly = manualUnitMapping(
      { value: 1, unit: "each" },
      { value: 5, unit: "dollar" },
    );
    expect(resolveBasisAmountPerEach([priceOnly], "g")).toBeNull();
  });
});

describe("computeNutrientDensityFigures", () => {
  it("computes protein density and cost-per-gram-protein from a resolvable each-to-grams basis", () => {
    const nutrients = buildNutrients({ protein: 30, kcal: 200 });

    const figures = computeNutrientDensityFigures(
      nutrients,
      [weightMapping],
      10,
    );

    // proteinPer100Kcal: 30 / 200 * 100 = 15
    expect(figures.proteinDensity).toBeCloseTo(15);
    // 30 g protein / 100 g * 500 g/each = 150 g protein per each;
    // $10 / 150 g protein ≈ $0.0667 / g protein
    expect(figures.costPerGramProtein).toBeCloseTo(10 / 150);
    expect(figures.needsWeightMapping).toBe(false);
  });

  it("reports needsWeightMapping instead of a wrong number when a price exists but no weight basis resolves", () => {
    const nutrients = buildNutrients({ protein: 30, kcal: 200 });

    const figures = computeNutrientDensityFigures(nutrients, [], 10);

    expect(figures.proteinDensity).toBeCloseTo(15);
    expect(figures.costPerGramProtein).toBeNull();
    expect(figures.needsWeightMapping).toBe(true);
  });

  it("does not report needsWeightMapping when there is no price to convert", () => {
    const nutrients = buildNutrients({ protein: 30, kcal: 200 });

    const figures = computeNutrientDensityFigures(nutrients, [], null);

    expect(figures.costPerGramProtein).toBeNull();
    expect(figures.needsWeightMapping).toBe(false);
  });

  it("honors nutrition-intel's zero-denominator guard for a resolvable basis with zero protein", () => {
    const nutrients = buildNutrients({ protein: 0, kcal: 200 });

    const figures = computeNutrientDensityFigures(
      nutrients,
      [weightMapping],
      10,
    );

    // gramsPerEach resolves, but 0 g protein/each -> costPerNutrient's
    // <= 0 denominator guard must still null it out, not divide by zero.
    expect(figures.costPerGramProtein).toBeNull();
    expect(figures.needsWeightMapping).toBe(false);
  });

  it("returns a null protein density when kcal is absent", () => {
    const nutrients = buildNutrients({ protein: 30 });

    const figures = computeNutrientDensityFigures(nutrients, [], null);

    expect(figures.proteinDensity).toBeNull();
  });
});
