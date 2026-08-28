import type { IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient";
import type { RecipeGraphOut, RecipeOut } from "@cubby/schemas/recipe";
import { useMemo } from "react";

import { computeRecipeCosting } from "~/lib/recipe-costing";

import { buildRecipeTree } from "./recipe-tree";
import { getIngredientName } from "./recipe-utils";
import { WASM_YIELD_PORTS } from "./yield-ports";

/**
 * Builds the full sub-recipe tree for the prep-sheet / nested-spec views.
 *
 * Takes the already-scaled recipe plus the `{ ingMap, recipeMap }` that
 * `useRecipeCostingData` loaded — so it never refetches, and `RecipeDetail` can
 * call it alongside its existing single-root costing without double work.
 *
 * The key move: cost the WHOLE closure as roots
 * (`[scaledRoot, ...Object.values(recipeMap)]`) in one `computeRecipeCosting`
 * call, so the returned map has a `RecipeCosting` per recipe id — each
 * sub-recipe costed at its native batch, which the tree needs to render every
 * level. Gated behind `enabled` so the cheaper single-root path the other views
 * use isn't taxed when these views aren't open.
 */
export function useRecipeTree(
  scaledRecipe: RecipeOut,
  ingMap: Record<string, IngredientWithFoodLeanOut> | null,
  recipeMap: Record<string, RecipeGraphOut>,
  enabled: boolean,
) {
  const costingById = useMemo(() => {
    if (!enabled || !ingMap) return null;
    const roots = [scaledRecipe, ...Object.values(recipeMap)];
    return computeRecipeCosting(roots, ingMap, getIngredientName, recipeMap);
  }, [enabled, scaledRecipe, ingMap, recipeMap]);

  const tree = useMemo(
    () =>
      costingById
        ? buildRecipeTree(
            scaledRecipe,
            costingById,
            recipeMap,
            WASM_YIELD_PORTS,
          )
        : null,
    [scaledRecipe, costingById, recipeMap],
  );

  return { tree, costingById };
}
