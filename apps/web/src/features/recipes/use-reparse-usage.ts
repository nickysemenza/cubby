import type { RecipeUsage } from "@cubby/schemas/recipe";

import { recipe } from "~/integrations/tanstack-query/generated/catalog.gen";
import { useActionMutation } from "~/ui/hooks/useActionMutation";

/**
 * Re-parse one usage's stored line through `recipe.reparseLine`. The server parses the source
 * line, compares it axis by axis, resolves a drifted name and writes only what changed (the rule
 * native's report row runs too), so this sends the line's ids and nothing more.
 */
export function useReparseUsage() {
  const reparseLine = useActionMutation({
    mutationFn: recipe.reparseLine.mutationOptions,
    error: "Re-parse failed",
    success: (result) =>
      result.status === "updated"
        ? `Re-parsed the line (${result.changed.join(", ")})`
        : "Nothing to update from a fresh parse.",
  });

  const reparse = async ({
    id,
    recipe: usageRecipe,
  }: Pick<RecipeUsage, "id" | "recipe">) => {
    await reparseLine
      .mutateAsync({ recipeId: usageRecipe.id, lineId: id })
      // `useActionMutation` already surfaces its own error toast.
      .catch(() => undefined);
  };

  return { reparse, isPending: reparseLine.isPending };
}
