/**
 * Internal type definitions for recipe repository.
 * Types used across recipe modules.
 */

import type { CookbookId } from "@cubby/schemas/identifiers";
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
  recipe: typeof recipe.$inferSelect | null;
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
  images: Array<{
    image: typeof image.$inferSelect;
    deletedAt?: Date | null;
  }>;
};

// Same section graph as RecipeDeepDB, but intentionally omits images. Used by
// costing/sub-recipe fetches that need recipe structure without media.
export type RecipeGraphDB = Omit<RecipeDeepDB, "images">;

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
  tagFilters?: string[];
  // Scope the list to a single cookbook by FK id. Powers the cookbook detail page.
  cookbookId?: CookbookId;
  // Drop recipes that are used as an ingredient elsewhere (a recipe-as-ingredient
  // Ingredient row points at them). Powers "what can I make?", where a sub-recipe
  // is a component, not a meal.
  excludeSubRecipes?: boolean;
}
