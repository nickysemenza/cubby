/**
 * Internal type definitions for recipe repository.
 * Types used across recipe modules.
 */

import type {
  image,
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";

/**
 * Type for deeply nested recipe query results.
 * Used when fetching recipes with full relations.
 */
export type RecipeDeepDB = typeof recipe.$inferSelect & {
  sections: Array<
    typeof recipeSection.$inferSelect & {
      ingredients: Array<
        typeof recipeSectionIngredient.$inferSelect & {
          ingredient: typeof ingredient.$inferSelect & {
            Recipe: typeof recipe.$inferSelect | null;
          };
        }
      >;
    }
  >;
  images: Array<{
    image: typeof image.$inferSelect;
  }>;
};

/**
 * Type for recipe section ingredient with relations.
 */
export type SectionIngredientDB =
  typeof recipeSectionIngredient.$inferSelect & {
    ingredient: typeof ingredient.$inferSelect & {
      Recipe: typeof recipe.$inferSelect | null;
    };
  };

/**
 * Type for existing recipe with sections (used in update operations).
 */
export type ExistingRecipeWithSections = typeof recipe.$inferSelect & {
  sections: Array<
    typeof recipeSection.$inferSelect & {
      ingredients: Array<typeof recipeSectionIngredient.$inferSelect>;
    }
  >;
};

/**
 * Filters for recipe list queries.
 */
export interface RecipeFilters {
  nameFilter?: string;
}
