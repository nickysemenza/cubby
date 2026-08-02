/**
 * Internal type definitions for recipe repository.
 * Types used across recipe modules.
 */

import type { CookbookId } from "@cubby/schemas/identifiers";
import type { PresenceFilter } from "@cubby/schemas/pagination";
import type {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import type { MappableImageRecord } from "~/server/repo/database-helpers";

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
    image: MappableImageRecord;
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
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  nameFilter?: string;
  tagFilters?: string[];
  // The tag column's "(none)" / "Has tags" sentinel. "none" is untagged —
  // null OR an empty array — and it ORs with `tagFilters` rather than
  // narrowing it. See TAGS_ARE_EMPTY in ./crud.ts.
  tagsPresenceFilter?: PresenceFilter;
  // Scope the list to a single cookbook by FK id (or several — see `oneOrMany`).
  // Powers the cookbook detail page.
  cookbookId?: CookbookId | CookbookId[];
  // The cookbook column's "(none)" / "Has cookbook" sentinel. ORs with
  // `cookbookId` rather than narrowing it (see `tagsPresenceFilter` above).
  cookbookPresenceFilter?: PresenceFilter;
  // Drop recipes that are used as an ingredient elsewhere (a recipe-as-ingredient
  // Ingredient row points at them). Powers "what can I make?", where a sub-recipe
  // is a component, not a meal.
  excludeSubRecipes?: boolean;
  // "none" is the never-planned worklist. A live MealRecipe under a
  // soft-deleted Meal doesn't count as a plan.
  mealPresenceFilter?: PresenceFilter;
  // "none" matches recipes with no live, non-PDF image.
  imagePresenceFilter?: PresenceFilter;
  costTotalMin?: number;
  costTotalMax?: number;
  caloriesTotalMin?: number;
  caloriesTotalMax?: number;
}
