import { type RecipeOut, recipeOut } from "@cubby/schemas/recipe";
import {
  testCompleteDataQuality,
  testEntityId,
  testShortcode,
} from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  collectIngredientIds,
  collectSubRecipeIds,
  recipeLinkSignature,
} from "./recipe-graph";

const recipe = (): RecipeOut =>
  recipeOut.parse({
    id: testShortcode("recipe", "RCP-4444"),
    source: null,
    name: "Root",
    meta: null,
    forkedFromRecipeId: null,
    forkedFromRecipeName: null,
    images: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    dataQuality: testCompleteDataQuality(),
    sections: [
      {
        id: testEntityId("recipe", "section"),
        name: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        instructions: [],
        ingredients: [
          {
            id: testEntityId("recipe", "row-1"),
            type: "ingredient",
            ingredient: {
              id: testShortcode("ingredient", "ING-4444"),
              name: "Flour",
              aliases: [],
              naKinds: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            recipe: null,
            amounts: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: testEntityId("recipe", "row-2"),
            type: "ingredient",
            ingredient: {
              id: testShortcode("ingredient", "ING-4444"),
              name: "Flour again",
              aliases: [],
              naKinds: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            recipe: null,
            amounts: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: testEntityId("recipe", "row-3"),
            type: "recipe",
            ingredient: null,
            recipe: {
              id: testShortcode("recipe", "RCP-5555"),
              name: "Sauce",
              meta: null,
              forkedFromRecipeId: null,
              forkedFromRecipeName: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            amounts: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
    ],
  });

describe("recipe graph helpers", () => {
  it("collects unique ingredient and sub-recipe ids", () => {
    const r = recipe();
    expect(collectIngredientIds([r])).toEqual(["ING-4444"]);
    expect(collectSubRecipeIds([r])).toEqual(["RCP-5555"]);
  });

  it("builds the existing costing data signature", () => {
    expect(recipeLinkSignature([recipe()])).toBe(
      "RCP-4444:ING-4444-ING-4444-rRCP-5555",
    );
  });
});
