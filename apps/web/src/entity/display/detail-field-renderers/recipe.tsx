import {
  RecipeSourceLink,
  sourceLabel,
} from "~/entity/presentation/recipe-source";

import type { EntityDetailFieldRenderers } from "./index";

export const recipeDetailFields = {
  "recipe-source": (recipe) => ({
    value: sourceLabel(recipe.source) ? (
      <RecipeSourceLink source={recipe.source} />
    ) : undefined,
  }),
} satisfies EntityDetailFieldRenderers<"recipe">;
