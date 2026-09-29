import type { RecipeUsage } from "@cubby/schemas/recipe";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showErrorToast } from "~/components/feedback/error-details";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { recipe } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import type { ParseDrift } from "~/lib/parse-drift";

import { useResolveIngredientName } from "./use-resolve-ingredient-names";

type UsageWithDrift = Pick<RecipeUsage, "id" | "recipe"> & {
  drift: ParseDrift;
};

/**
 * Apply a usage's fresh parse to its stored line through `recipe.patchLine`.
 * A drifted name is resolved through the server's find-or-create (the same
 * resolution the Problems page's batch re-parse uses), so the line points at a
 * real ingredient rather than a name.
 *
 * `patchLine` cannot clear amounts (a patch carries at least one), so a parse
 * that drifted to no amount leaves the stored amount alone.
 */
export function useReparseUsage() {
  const queryClient = useQueryClient();
  const patchLine = useMutation(recipe.patchLine.mutationOptions());
  const { resolveName } = useResolveIngredientName();

  const reparse = async ({
    id,
    recipe: usageRecipe,
    drift,
  }: UsageWithDrift) => {
    try {
      const freshAmounts = drift.amounts?.filter((a) => a.value > 0) ?? [];
      const patch = {
        ...(freshAmounts.length > 0 && {
          amounts: freshAmounts.map((a) => ({
            value: a.value,
            unit: a.unit,
            ...(a.upper_value != null && { upperValue: a.upper_value }),
          })),
        }),
        ...(drift.modifier !== null && { modifier: drift.modifier }),
        ...(drift.name !== null && {
          ingredientId: (await resolveName(drift.name)).id,
        }),
      };
      if (Object.keys(patch).length === 0) {
        toast.info("Nothing to update from a fresh parse.");
        return;
      }
      await patchLine.mutateAsync({
        recipeId: usageRecipe.id,
        lineId: id,
        patch,
      });
      // The usage list is an ingredient read, not a recipe one.
      await invalidateOperationTags(queryClient, ripple.ingredient);
      toast.success(`Re-parsed the line in ${usageRecipe.name}`);
    } catch (error) {
      showErrorToast(error, "Re-parse failed");
    }
  };

  return { reparse, isPending: patchLine.isPending };
}
