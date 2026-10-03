import type { NutrientSummary } from "@cubby/usda";
import { describe, expect, it } from "vitest";

import { buildNutritionDisplay } from "./nutrition-display";

const usda = (nutrientSummary: NutrientSummary[]) => ({
  nutritionInfo: { nutrientSummary, nutrientsPer100: {} },
});

// Failure modes: a label silently losing to USDA (or the reverse) on one
// platform; a per-serving label labelled "Per 100 g"; an inferred zero shown
// as a measured one; an empty USDA food rendered as a populated panel. Web and
// native both render this, so a wrong pick shows on both.
describe("product nutrition display", () => {
  it("is empty when there is neither a label nor a USDA nutrient", () => {
    expect(
      buildNutritionDisplay({
        labelNutrition: null,
        food: usda([]),
      }),
    ).toMatchObject({ source: "none", rows: [] });
    expect(
      buildNutritionDisplay({ labelNutrition: null, food: null }),
    ).toMatchObject({
      source: "none",
      title:
        "No nutrition on file — link a USDA food or enter the package label.",
    });
  });

  it("the package label leads over USDA and is stated per serving", () => {
    const display = buildNutritionDisplay({
      labelNutrition: {
        servingGrams: 44,
        nutrients: { sodium: 210.5, protein: 3 },
        inferredZeroNutrients: ["fiber", "protein"],
        inferenceEvidence: "Panel lists no fiber",
        source: "Synthetic package label",
      },
      food: usda([{ name: "Protein", amount: 9, unit: "G" }]),
    });
    expect(display).toEqual({
      source: "label",
      title: "From package label",
      basis: "Per serving · 44 g",
      sourceNote: "Synthetic package label",
      inferenceEvidence: "Panel lists no fiber",
      rows: [
        { key: "protein", label: "Protein (g)", value: "3" },
        { key: "sodium", label: "Sodium (mg)", value: "210.5" },
        { key: "fiber", label: "Fiber (g)", value: "0 · inferred from label" },
      ],
    });
  });

  it("falls back to the USDA nutrient summary per 100 g", () => {
    expect(
      buildNutritionDisplay({
        labelNutrition: null,
        food: usda([
          { name: "Protein", amount: 12.34567, unit: "G" },
          { name: "Energy", amount: 250, unit: "KCAL" },
        ]),
      }),
    ).toEqual({
      source: "usda",
      title: "From USDA",
      basis: "Per 100 g",
      sourceNote: null,
      inferenceEvidence: null,
      rows: [
        { key: "Protein", label: "Protein (G)", value: "12.346" },
        { key: "Energy", label: "Energy (KCAL)", value: "250" },
      ],
    });
  });
});
