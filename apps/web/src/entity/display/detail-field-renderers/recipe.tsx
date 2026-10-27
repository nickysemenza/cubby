import { fieldValueOf } from "@cubby/schemas/field-envelope";

import {
  RecipeSourceLink,
  sourceLabel,
} from "~/entity/presentation/recipe-source";

import type { EntityDetailFieldRenderers } from "./index";

export const recipeDetailFields = {
  "recipe-source": (recipe) => {
    const effectiveRecipeSource = fieldValueOf(recipe.fields.source);
    return {
      value: sourceLabel(effectiveRecipeSource) ? (
        <RecipeSourceLink source={effectiveRecipeSource} />
      ) : undefined,
    };
  },
} satisfies EntityDetailFieldRenderers<"recipe">;
