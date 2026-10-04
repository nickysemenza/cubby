import {
  RecipeSourceLink,
  sourceLabel,
} from "~/features/recipes/recipe-source";

import type { EntityDetailFieldRenderers } from "./index";

export const recipeDetailFields = {
  "recipe-source": (recipe) => ({
    value: sourceLabel(recipe.source) ? (
      <RecipeSourceLink source={recipe.source} />
    ) : undefined,
  }),
} satisfies EntityDetailFieldRenderers<"recipe">;
