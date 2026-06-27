import { unsafeIngredientId, unsafeRecipeId } from "@cubby/schemas/identifiers";
import type { RecipeOut } from "@cubby/schemas/recipe-responses";
import { describe, expect, it } from "vitest";
import {
  collectIngredientIds,
  collectSubRecipeIds,
  recipeLinkSignature,
} from "./recipe-graph";

const recipe = (): RecipeOut =>
  ({
    id: unsafeRecipeId("r-root"),
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
            ingredient: { id: unsafeIngredientId("i-1"), name: "Flour" },
            recipe: null,
            amounts: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: "row-2",
            type: "ingredient",
            ingredient: {
              id: unsafeIngredientId("i-1"),
              name: "Flour again",
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
              id: unsafeRecipeId("r-child"),
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
    expect(collectIngredientIds([r])).toEqual(["i-1"]);
    expect(collectSubRecipeIds([r])).toEqual(["r-child"]);
  });

  it("builds the existing costing data signature", () => {
    expect(recipeLinkSignature([recipe()])).toBe("r-root:i-1-i-1-rr-child");
  });
});
