import { unsafeIngredientId, unsafeRecipeId } from "@cubby/schemas/identifiers";
import type {
  RecipeOut,
  SectionIngredient,
} from "@cubby/schemas/recipe-responses";
import { expect, it } from "vitest";
import {
  formatYield,
  getIngredientName,
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
              id: unsafeIngredientId("ingredient"),
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
              id: unsafeRecipeId("sub-recipe"),
              name: "flour-r",
              createdAt: new Date(),
              updatedAt: new Date(),
              meta: null,
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
    id: unsafeRecipeId("recipe"),
    name: "",
    meta: null,
    images: [],
    createdAt: new Date(),
    updatedAt: new Date(),
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
  const base = {
    id: unsafeRecipeId("r"),
    name: "Recipe",
    meta: null,
    images: [],
    sections: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as RecipeOut;

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
