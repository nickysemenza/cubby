import { productWithFoodMcpEntityOut } from "@cubby/schemas/product";
import type { NutrientSummary } from "@cubby/usda";
import { describe, expect, it } from "vitest";

import { buildNutritionDisplay } from "./nutrition-display";

const usda = (
  nutrientsPer100: Record<string, number>,
  nutrientSummary: NutrientSummary[] = [],
) => ({ nutritionInfo: { nutrientSummary, nutrientsPer100 } });

// Failure modes: a label silently losing to USDA (or the reverse) on one
// platform; a per-serving label labelled "Per 100 g"; an inferred zero shown
// as a measured one; an empty USDA food rendered as a populated panel. Web and
// native both render this, so a wrong pick shows on both.
describe("product nutrition display", () => {
  it("is empty when there is neither a label nor a USDA nutrient", () => {
    expect(
      buildNutritionDisplay({
        labelNutrition: null,
        food: usda({}),
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
      food: usda({ "203": 9 }),
    });
    expect(display).toEqual({
      source: "label",
      title: "From package label",
      basis: "Per serving · 44 g",
      sourceNote: "Synthetic package label",
      inferenceEvidence: "Panel lists no fiber",
      rows: [
        { key: "protein", label: "Protein (g)", amount: 3, inferred: false },
        { key: "sodium", label: "Sodium (mg)", amount: 210.5, inferred: false },
        { key: "fiber", label: "Fiber (g)", amount: 0, inferred: true },
      ],
    });
  });

  it("falls back to the tier-1 per-100 g figures, not the full USDA table", () => {
    const fullTable: NutrientSummary[] = Array.from(
      { length: 115 },
      (_, i) => ({
        name: `Nutrient ${i}`,
        amount: i,
        unit: "G",
      }),
    );
    const display = buildNutritionDisplay({
      labelNutrition: null,
      food: usda({ "203": 12.34567, "208": 1046 }, fullTable),
    });
    expect(display).toEqual({
      source: "usda",
      title: "From USDA",
      basis: "Per 100 g",
      sourceNote: null,
      inferenceEvidence: null,
      rows: [
        {
          key: "protein",
          label: "Protein (g)",
          amount: 12.346,
          inferred: false,
        },
        {
          key: "kcal",
          label: "Calories (kcal)",
          amount: 1046,
          inferred: false,
        },
      ],
    });
  });

  it("does not claim USDA when only the untracked summary has data", () => {
    expect(
      buildNutritionDisplay({
        labelNutrition: null,
        food: usda({}, [{ name: "Zinc", amount: 1, unit: "MG" }]),
      }).source,
    ).toBe("none");
  });

  it("the MCP product projection carries no full nutrient table", () => {
    const nutritionInfo =
      productWithFoodMcpEntityOut.shape.food.unwrap().shape.nutritionInfo.shape;
    expect(nutritionInfo).not.toHaveProperty("nutrientSummary");
  });
});
