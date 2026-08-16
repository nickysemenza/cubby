import { useNavigate } from "@tanstack/react-router";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useTRPC } from "~/integrations/trpc/react";
import { recipeMutationInvalidateKeys } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

/**
 * Duplicate a recipe and jump to the copy. Shared by the detail page's
 * actions block and the recipe list's row menu so "Duplicate" behaves
 * identically everywhere it's offered.
 */
export function useDuplicateRecipe() {
  const api = useTRPC();
  const navigate = useNavigate();
  const mutation = useActionMutation({
    mutationFn: api.recipe.duplicate.mutationOptions,
    success: (data) => savedWithBackgroundWork(data.sideEffects, "Duplicated"),
    invalidateKeys: recipeMutationInvalidateKeys,
    onSuccess: (data) => {
      navigate({ to: "/recipes/$shortcode", params: { shortcode: data.id } });
    },
  });
  return {
    duplicateRecipe: (id: string) => mutation.mutate({ id }),
    isPending: mutation.isPending,
  };
}
