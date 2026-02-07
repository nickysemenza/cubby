/**
 * Recipe transformation helpers.
 * Convert database records to API types.
 */

import type {
  RecipeOut,
  recipeTopLevel,
  SectionIngredient,
} from "@cubby/schemas/recipe";
import type { z } from "zod";
import type { recipe } from "~/server/db/schema";
import {
  extractImagesFromJoinTable,
  mapRelation,
} from "~/server/repo/database-helpers";

import type { RecipeDeepDB, SectionIngredientDB } from "./internal-types";

type RecipeSelect = typeof recipe.$inferSelect;

/**
 * Convert a recipe section ingredient DB record to API type.
 * Handles both regular ingredients and recipe references.
 */
export const sectionIngredientToAPI = (
  sectionIngredient: SectionIngredientDB,
): SectionIngredient => {
  if (sectionIngredient.ingredient?.Recipe) {
    return {
      ...sectionIngredient,
      type: "recipe",
      recipe: dbRecipeToAPIShallow(sectionIngredient.ingredient.Recipe),
      ingredient: null,
      amounts: sectionIngredient.amounts,
    };
  } else {
    return {
      ...sectionIngredient,
      type: "ingredient",
      recipe: null,
      ingredient: sectionIngredient.ingredient ?? null,
      amounts: sectionIngredient.amounts,
    };
  }
};

/**
 * Convert a recipe DB record to shallow API type (without sections).
 * Used for recipe references within ingredients.
 */
export const dbRecipeToAPIShallow: (
  recipeParam: RecipeSelect,
) => z.infer<typeof recipeTopLevel> = (recipeData) => {
  const { SourceType, SourceData, ...restOfRecipe } = recipeData;
  return {
    meta: {
      url: SourceType === "Website" ? SourceData : null,
    },
    ...restOfRecipe,
  };
};

/**
 * Convert a full recipe DB record to API type (with sections).
 */
export const dbRecipeToAPI = (recipeData: RecipeDeepDB): RecipeOut => {
  const { sections, SourceData, SourceType, images, ...restOfRecipe } =
    recipeData;

  return {
    ...restOfRecipe,
    meta: {
      url: SourceType === "Website" ? SourceData : null,
    },
    images: extractImagesFromJoinTable(images),
    sections: mapRelation(sections, (section) => {
      const { ingredients, instructions, ...restOfSection } = section;
      return {
        ...restOfSection,
        ingredients: mapRelation(ingredients, sectionIngredientToAPI),
        // Map JSON instructions array to the expected format
        instructions: Array.isArray(instructions)
          ? instructions.map((instruction: { text: string }) => {
              return { instruction: instruction.text };
            })
          : [],
      };
    }),
  };
};
