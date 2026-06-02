import type { RecipeOut, SectionIngredient } from "@cubby/schemas/recipe";
import { expect, test } from "vitest";
import {
  formatYield,
  getGlobalInstructionNumber,
  getIngredientName,
} from "./recipe-utils";

test("recipe utils", () => {
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
              id: "",
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
              id: "",
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
    id: "",
    name: "",
    meta: null,
    images: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  expect(getGlobalInstructionNumber(recipe, 1, 0)).toEqual(1);
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
 * CHARACTERIZATION — documents CURRENT, intentionally-wrong behavior: a unitless
 * yield renders the parser's "whole" sentinel ("18 whole"). The fix is to drop
 * the unit when it equals "whole" (and flip the assertion below), alongside the
 * deferred ingredient-parser work. See the plan.
 */
test('formatYield currently leaks the "whole" unit', () => {
  // TODO(whole): should become "18" once we drop the "whole" unit.
  expect(formatYield({ value: 18, unit: "whole" })).toEqual("18 whole");
  // Real units render normally:
  expect(formatYield({ value: 12, unit: "servings" })).toEqual("12 servings");
});
