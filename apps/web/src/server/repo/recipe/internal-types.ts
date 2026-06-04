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
 * An ingredient row joined with its optional backing Recipe (set when the
 * ingredient is itself a sub-recipe). Shared building block for the types below.
 */
type IngredientWithRecipeDB = typeof ingredient.$inferSelect & {
  Recipe: typeof recipe.$inferSelect | null;
};

/**
 * Type for recipe section ingredient with relations.
 * Also the element type of a deeply-nested section's `ingredients` array.
 */
export type SectionIngredientDB =
  typeof recipeSectionIngredient.$inferSelect & {
    ingredient: IngredientWithRecipeDB;
  };

/**
 * Type for deeply nested recipe query results.
 * Used when fetching recipes with full relations.
 */
export type RecipeDeepDB = typeof recipe.$inferSelect & {
  sections: Array<
    typeof recipeSection.$inferSelect & {
      ingredients: Array<SectionIngredientDB>;
    }
  >;
  // Optional: the recipe LIST query (relations.recipe.list) omits images since
  // the table never renders them; the detail query (relations.recipe.full)
  // still includes them. extractImagesFromJoinTable() returns [] when absent.
  images?: Array<{
    image: typeof image.$inferSelect;
  }>;
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
  // Scope the list to a single cookbook (SourceType='Book', SourceData=book).
  // Powers the cookbook detail / browse-by-source page.
  book?: string;
}
