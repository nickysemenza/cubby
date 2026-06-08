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
import { recipeSourceFromDb } from "./source";

type RecipeSelect = typeof recipe.$inferSelect;

/**
 * Convert a recipe section ingredient DB record to API type.
 * Handles both regular ingredients and recipe references.
 */
const sectionIngredientToAPI = (
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
  // cookbookId is the FK, not a top-level API field — pull it out of the row so it
  // isn't spread into the output, but feed it to the source codec so a book
  // recipe's `source` carries its cookbook id (for linking).
  const { SourceType, SourceData, cookbookId, ...restOfRecipe } = recipeData;
  return {
    // The DB stores provenance as SourceType + SourceData; the API exposes a single
    // meta.url. This derivation is deliberately kept (rather than collapsing the two
    // columns into one nullable sourceUrl) to avoid a DB migration + backfill.
    meta: {
      url: SourceType === "Website" ? SourceData : null,
    },
    // Strong provenance union — surfaces the book name + cookbook id for cookbook
    // recipes (meta.url only ever held web URLs).
    source: recipeSourceFromDb({ SourceType, SourceData, cookbookId }),
    ...restOfRecipe,
  };
};

/**
 * Convert a full recipe DB record to API type (with sections).
 */
export const dbRecipeToAPI = (recipeData: RecipeDeepDB): RecipeOut => {
  const {
    sections,
    SourceData,
    SourceType,
    cookbookId,
    images,
    ...restOfRecipe
  } = recipeData;

  return {
    ...restOfRecipe,
    // See dbRecipeToAPIShallow: SourceType/SourceData -> meta.url derivation is kept
    // deliberately to avoid a DB migration.
    meta: {
      url: SourceType === "Website" ? SourceData : null,
    },
    source: recipeSourceFromDb({ SourceType, SourceData, cookbookId }),
    images: extractImagesFromJoinTable(images),
    sections: mapRelation(sections, (section) => {
      const { ingredients, instructions, ...restOfSection } = section;
      return {
        ...restOfSection,
        ingredients: mapRelation(ingredients, sectionIngredientToAPI),
        // The DB stores each instruction as { text }, the API/form use { instruction }.
        // This rename is deliberately kept to avoid a JSONB migration + backfill.
        instructions: Array.isArray(instructions)
          ? instructions.map((instruction: { text: string }) => {
              return { instruction: instruction.text };
            })
          : [],
      };
    }),
  };
};
