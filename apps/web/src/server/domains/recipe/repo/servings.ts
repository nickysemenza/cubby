import type { FieldResolutions } from "@cubby/schemas/field-resolution";
import {
  resolveRecipeServingValue,
  type RecipeServingBasis,
} from "@cubby/schemas/recipe-shared";

export const resolveRecipeServings = (
  recipe: Pick<RecipeServingBasis, "servings" | "yield">,
): FieldResolutions => {
  const storedValue = recipe.servings ?? null;
  const fallbackValue = resolveRecipeServingValue({
    ...recipe,
    servings: null,
  });
  const value = resolveRecipeServingValue(recipe);
  return {
    servings: {
      mode: storedValue === null ? "inherit" : "explicit",
      storedValue,
      value,
      fallbackValue,
      source:
        storedValue !== null
          ? "Explicit servings"
          : fallbackValue !== null
            ? "Recipe yield"
            : "No serving yield",
      sourceEntity: null,
      matchesFallback: value === fallbackValue,
      canReset: storedValue !== null,
    },
  };
};
