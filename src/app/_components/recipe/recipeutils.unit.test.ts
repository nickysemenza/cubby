import { expect, test } from "vitest";
import { type SectionIngredient, type RecipeOut } from "~/schemas/recipe";
import { getGlobalInstructionNumber, getIngredientName } from "./recipeutils";

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
