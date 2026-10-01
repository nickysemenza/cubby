import type { z } from "zod";

import { recipeOut, sectionIngredientOut } from "../recipe";
import { testCompleteDataQuality } from "./identifiers";

/** Shared builders for the recipe-shaped rows web tests render. */

type LineInput = z.input<typeof sectionIngredientOut>;
type RecipeInput = z.input<typeof recipeOut>;

const STAMP = {
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

/** A recipe section line pointing at an Ingredient. */
export const testIngredientLine = (line: {
  id: LineInput["id"];
  ingredientId: NonNullable<LineInput["ingredient"]>["id"];
  name: string;
}) =>
  sectionIngredientOut.parse({
    id: line.id,
    type: "ingredient",
    amounts: [],
    modifier: null,
    rawLine: null,
    recipe: null,
    ingredient: {
      id: line.ingredientId,
      name: line.name,
      aliases: [],
      naKinds: [],
      ...STAMP,
    },
    ...STAMP,
  });

/** A recipe section line pointing at another Recipe, with an optional written amount. */
export const testSubRecipeLine = (line: {
  id: LineInput["id"];
  recipeId: NonNullable<LineInput["recipe"]>["id"];
  name: string;
  amounts?: LineInput["amounts"];
}) =>
  sectionIngredientOut.parse({
    id: line.id,
    type: "recipe",
    amounts: line.amounts ?? [],
    modifier: null,
    rawLine: null,
    ingredient: null,
    recipe: {
      id: line.recipeId,
      name: line.name,
      meta: null,
      forkedFromRecipeId: null,
      forkedFromRecipeName: null,
      ...STAMP,
    },
    ...STAMP,
  });

/** A Recipe with no sections, images, or tags. */
export const testEmptyRecipe = (recipe: {
  id: RecipeInput["id"];
  name: string;
}) =>
  recipeOut.parse({
    id: recipe.id,
    name: recipe.name,
    meta: null,
    yield: null,
    servings: null,
    notes: null,
    forkedFromRecipeId: null,
    forkedFromRecipeName: null,
    source: null,
    images: [],
    sections: [],
    tags: [],
    ...STAMP,
    dataQuality: testCompleteDataQuality(),
  });
