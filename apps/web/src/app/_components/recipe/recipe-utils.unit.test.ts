import { totalsPreview } from "@cubby/schemas/nutrition";
import type { RecipeOut, SectionIngredient } from "@cubby/schemas/recipe";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { expect, it } from "vitest";

import {
  formatYield,
  getIngredientName,
  getRecipeNutritionBasis,
  getServingBasis,
} from "./recipe-utils";

it("recipe utils", () => {
  const recipe: RecipeOut = {
    sections: [
      {
        ingredients: [],
        instructions: [],
        id: "",
        name: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        ingredients: [
          {
            id: "",
            type: "ingredient",
            createdAt: new Date(),
            updatedAt: new Date(),
            recipe: null,
            ingredient: {
              id: testShortcode("ingredient", "ING-2345"),
              name: "flour-i",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            amounts: [],
          },
          {
            id: "",
            type: "recipe",
            createdAt: new Date(),
            updatedAt: new Date(),
            ingredient: null,
            recipe: {
              id: testShortcode("recipe", "RCP-2345"),
              name: "flour-r",
              createdAt: new Date(),
              updatedAt: new Date(),
              meta: null,
              forkedFromRecipeId: null,
              forkedFromRecipeName: null,
            },
            amounts: [],
          },
        ],
        instructions: [{ instruction: "Mix ingredients" }],
        id: "",
        name: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    id: testShortcode("recipe", "RCP-2346"),
    name: "",
    meta: null,
    images: [],
    dataQuality: testCompleteDataQuality(),
    createdAt: new Date(),
    updatedAt: new Date(),
    forkedFromRecipeId: null,
    forkedFromRecipeName: null,
    ...totalsPreview(null),
  };
  let si: SectionIngredient | undefined = recipe.sections[1]?.ingredients[0];
  expect(si).toBeDefined();
  if (!si) return;
  expect(getIngredientName(si)).toEqual("flour-i");
  si = recipe.sections[1]?.ingredients[1];
  expect(si).toBeDefined();
  if (!si) return;
  expect(getIngredientName(si)).toEqual("flour-r");
});

it("nutrition basis requires a serving count and preserves one serving", () => {
  expect(
    getRecipeNutritionBasis({ yield: { value: 300, unit: "g" } }, "serving"),
  ).toMatchObject({ basis: "whole", factor: 1, hasServing: false });
  expect(
    getRecipeNutritionBasis(
      { servings: 1, yield: { value: 300, unit: "g" } },
      "serving",
    ),
  ).toMatchObject({ basis: "serving", factor: 1, label: "per serving" });
  expect(
    getRecipeNutritionBasis(
      { yield: { value: 4, unit: "servings" } },
      "serving",
    ),
  ).toMatchObject({ basis: "serving", factor: 0.25 });
  expect(getRecipeNutritionBasis({ servings: 4 }, "whole")).toMatchObject({
    basis: "whole",
    factor: 1,
  });
});

it("keeps per-serving nutrition independent of fractional display rounding", () => {
  const recipeScale = 0.3333;
  const basis = getRecipeNutritionBasis(
    { servings: 2 },
    "serving",
    recipeScale,
  );
  expect(150 * recipeScale * basis.factor).toBeCloseTo(75);
  expect(250 * recipeScale * basis.factor).toBeCloseTo(125);
});

/**
 * A unitless yield carries the parser's "whole" sentinel; formatYield drops it
 * so "18 whole" renders as "18". Real units render normally.
 */
it("formatYield drops the bare-count 'whole' unit", () => {
  expect(formatYield({ value: 18, unit: "whole" })).toEqual("18");
  // Real units render normally:
  expect(formatYield({ value: 12, unit: "servings" })).toEqual("12 servings");
});

it("getServingBasis prefers servings and labels yield units", () => {
  const base: RecipeOut = {
    id: testShortcode("recipe", "RCP-2347"),
    name: "Recipe",
    meta: null,
    images: [],
    sections: [],
    dataQuality: testCompleteDataQuality(),
    createdAt: new Date(),
    updatedAt: new Date(),
    forkedFromRecipeId: null,
    forkedFromRecipeName: null,
    ...totalsPreview(null),
  };

  expect(getServingBasis({ ...base, servings: 4 })).toEqual({
    divisor: 4,
    noun: "serving",
  });
  expect(
    getServingBasis({ ...base, yield: { value: 12, unit: "churros" } }),
  ).toEqual({ divisor: 12, noun: "churro" });
  expect(
    getServingBasis({ ...base, yield: { value: 2, unit: "whole" } }),
  ).toEqual({ divisor: 2, noun: "each" });
  expect(getServingBasis({ ...base, yield: { value: 1, unit: "loaf" } })).toBe(
    null,
  );
});
