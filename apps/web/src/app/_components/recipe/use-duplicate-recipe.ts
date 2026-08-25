import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { recipeDuplicateMutationOptions } from "~/app/recipes/recipe.functions";
import { invalidatesFor } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

/**
 * Duplicate a recipe and jump to the copy. Shared by the detail page's
 * actions block and the recipe list's row menu so "Duplicate" behaves
 * identically everywhere it's offered.
 */
export function useDuplicateRecipe() {
  const navigate = useNavigate();
  const mutation = useActionMutation({
    mutationFn: recipeDuplicateMutationOptions,
    success: (data) => savedWithBackgroundWork(data.sideEffects, "Duplicated"),
    invalidateKeys: invalidatesFor("recipe", "list"),
    onSuccess: (data) => {
      navigate({ to: "/recipes/$shortcode", params: { shortcode: data.id } });
    },
  });
  // `mutate` is stable across renders, so wrapping it keeps `duplicateRecipe`
  // stable too — without this the returned closure is new every render and
  // the consumer's `useCallback([duplicateRecipe, ...])` never memoizes.
  const { mutate } = mutation;
  return {
    duplicateRecipe: useCallback((id: string) => mutate({ id }), [mutate]),
    isPending: mutation.isPending,
  };
}
