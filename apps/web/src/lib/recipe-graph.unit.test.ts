import type { RecipeOut } from "@cubby/schemas/recipe";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import {
  collectIngredientIds,
  collectSubRecipeIds,
  recipeLinkSignature,
} from "./recipe-graph";

const recipe = (): RecipeOut =>
  ({
    id: testShortcode("recipe", "RCP-4444"),
    source: null,
    name: "Root",
    meta: null,
    images: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    sections: [
      {
        id: "s-1",
        name: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        instructions: [],
        ingredients: [
          {
            id: "row-1",
            type: "ingredient",
            ingredient: {
              id: testShortcode("ingredient", "ING-4444"),
              name: "Flour",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            recipe: null,
            amounts: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: "row-2",
            type: "ingredient",
            ingredient: {
              id: testShortcode("ingredient", "ING-4444"),
              name: "Flour again",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            recipe: null,
            amounts: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: "row-3",
            type: "recipe",
            ingredient: null,
            recipe: {
              id: testShortcode("recipe", "RCP-5555"),
              name: "Sauce",
              meta: null,
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
  }) as RecipeOut;

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
