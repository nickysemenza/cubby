import { recipeStreams } from "~/integrations/tanstack-query/generated/catalog.gen";

export const openRecipeRecomputeAllStream = (signal?: AbortSignal) =>
  recipeStreams.recomputeAllDurable.open(undefined, { signal });
export const openRecipeRecomputeStaleStream = (signal?: AbortSignal) =>
  recipeStreams.recomputeStaleDurable.open(undefined, { signal });
