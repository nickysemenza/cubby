import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { recipeGetAllTagsQueryOptions } from "~/app/recipes/recipe.functions";

const NO_TAG_OPTIONS: Array<{ value: string; label: string }> = [];

/**
 * The recipe tag universe as `{value,label}` options (a tag's value and label
 * are the same string) — feeds the recipe list's Tags filter (`optionsKey:
 * "tags"`). Promoted out of `recipelist.tsx` for symmetry with
 * `useProjectOptions`/`useCookbookOptions`/`useLocationParentOptions` — it was
 * the one picklist still built ad hoc inline.
 */
export function useRecipeTagOptions() {
  const { data, isLoading } = useQuery(recipeGetAllTagsQueryOptions());

  const options = useMemo(
    () => data?.map((tag) => ({ value: tag, label: tag })) ?? NO_TAG_OPTIONS,
    [data],
  );

  return { options, isLoading };
}
