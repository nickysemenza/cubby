import type { RecipeOut, SectionIngredient } from "@cubby/schemas/recipe";
import { assertNever } from "~/lib/assert";

/**
 * Format a recipe yield for display, e.g. "18 servings". A unitless yield
 * carries the parser's "whole" sentinel (a bare count); drop it so "18 whole"
 * renders as just "18".
 */
export const formatYield = (y: { value: number; unit: string }): string =>
  y.unit === "whole" ? `${y.value}` : `${y.value} ${y.unit}`;

/** Effective servings: explicit servings, or the yield value when its unit is "servings". */
export const getEffectiveServings = (recipe: RecipeOut): number | null => {
  if (recipe.servings) return recipe.servings;
  if (recipe.yield?.unit === "servings") return recipe.yield.value;
  return null;
};

// Matches the flour that forms a baker's-percentage base. Substring "flour"
// catches bread/AP/all-purpose/whole-wheat/white/cake/pastry/00/durum flour;
// a few common flours-by-other-name are listed explicitly.
const FLOUR_TERMS = ["flour", "semolina"];

export const isFlourIngredient = (name: string): boolean => {
  const n = name.toLowerCase();
  return FLOUR_TERMS.some((t) => n.includes(t));
};

// Re-exported from a server-safe module so the costing rollup can run server-side
// too; kept here for existing client callers.
export { isFryingMediumIngredient } from "~/lib/ingredient-utils";

export const getIngredientName = (ingredient: SectionIngredient): string => {
  const { type } = ingredient;
  switch (type) {
    case "ingredient":
      return ingredient.ingredient.name;
    case "recipe":
      return ingredient.recipe.name;
    default:
      return assertNever(type);
  }
};
