import { recipeStreams } from "~/integrations/tanstack-query/generated/recipe.gen";

export const openRecipeRecomputeAllStream = (signal?: AbortSignal) =>
  recipeStreams.recomputeAllDurable.open(undefined, { signal });
export const openRecipeRecomputeStaleStream = (signal?: AbortSignal) =>
  recipeStreams.recomputeStaleDurable.open(undefined, { signal });
