import type { RecipeShortcode } from "@cubby/schemas/identifiers";
import type { IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient";
import type { RecipeGraphOut, RecipeOut } from "@cubby/schemas/recipe";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { chunk, keyBy } from "es-toolkit";
import { useEffect, useMemo, useRef, useState } from "react";

import { ingredient } from "~/app/ingredients/ingredient.functions";
import { recipe } from "~/app/recipes/recipe.functions";
import { showErrorToast } from "~/components/feedback/error-details";
import {
  collectIngredientIds,
  collectSubRecipeIds,
  recipeLinkSignature,
} from "~/lib/recipe-graph";
import { ID_CHUNK_SIZE } from "~/misc/array-helpers";

type RecipeCostingData = {
  ingMap: Record<string, IngredientWithFoodLeanOut>;
  recipeMap: Record<string, RecipeGraphOut>;
};

/**
 * Loads everything the client-side cost rollup needs for a set of recipes: the
 * ingredient data for every ingredient (`ingMap`) AND the full graph of any
 * sub-recipes used as ingredients (`recipeMap`), walked transitively so nested
 * sub-recipes resolve too. The seen-set doubles as a cycle guard.
 *
 * Pure async (no React) so both the recipe list effect and {@link
 * useRecipeCostingData} can share it. Fetches are batched and cached via React
 * Query (`ensureQueryData`).
 */
async function loadRecipeCostingData(
  recipes: RecipeOut[],
  queryClient: QueryClient,
): Promise<RecipeCostingData> {
  // 1. Transitive closure of sub-recipes (recipe-as-ingredient). Each fetched
  // recipe may reference further sub-recipes; loop until none are new.
  const fetched: Record<string, RecipeGraphOut> = {};
  const seen = new Set<string>();
  let frontier = collectSubRecipeIds(recipes);
  while (frontier.length > 0) {
    const toFetch = frontier.filter((id) => !seen.has(id));
    for (const id of toFetch) seen.add(id);
    if (toFetch.length === 0) break;

    const chunks = await Promise.all(
      chunk(toFetch.sort(), ID_CHUNK_SIZE).map((ids) =>
        queryClient.ensureQueryData(recipe.getManyByIDs.queryOptions({ ids })),
      ),
    );

    const next: RecipeShortcode[] = [];
    for (const r of chunks.flat()) {
      fetched[r.id] = r;
      next.push(...collectSubRecipeIds([r]));
    }
    frontier = next;
  }

  // 2. Ingredient data for every ingredient across the input recipes AND every
  // fetched sub-recipe, batched (sorted → stable cache keys).
  const ingredientIds = collectIngredientIds([
    ...recipes,
    ...Object.values(fetched),
  ]);
  const chunkResults = await Promise.all(
    chunk(ingredientIds.sort(), ID_CHUNK_SIZE).map((ids) =>
      queryClient.ensureQueryData(
        ingredient.getManyByIDs.queryOptions({ ids }),
      ),
    ),
  );
  const ingMap = keyBy(chunkResults.flat(), (ing) => ing.id);

  return { ingMap, recipeMap: fetched };
}

/**
 * React wrapper around {@link loadRecipeCostingData} for the recipe detail view.
 * `ingMap` is `null` until the first load completes (so callers can distinguish
 * "loading" from "loaded but empty"). Fetching is gated on a stable content
 * signature so streaming/refetch re-renders don't restart the work.
 */
export function useRecipeCostingData(recipes: RecipeOut[]) {
  const queryClient = useQueryClient();

  const [ingMap, setIngMap] = useState<Record<
    string,
    IngredientWithFoodLeanOut
  > | null>(null);
  const [recipeMap, setRecipeMap] = useState<Record<string, RecipeGraphOut>>(
    {},
  );
  const [isLoading, setIsLoading] = useState(false);

  // Read the latest recipes through a ref so the effect can depend on a stable
  // content signature instead of the array reference (which changes every tick).
  const recipesRef = useRef(recipes);
  recipesRef.current = recipes;
  const signature = useMemo(() => recipeLinkSignature(recipes), [recipes]);

  useEffect(() => {
    let cancelled = false;
    const current = recipesRef.current;

    if (current.length === 0) {
      setIngMap({});
      setRecipeMap({});
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    loadRecipeCostingData(current, queryClient)
      .then(({ ingMap: nextIngMap, recipeMap: nextRecipeMap }) => {
        if (cancelled) return;
        setRecipeMap(nextRecipeMap);
        setIngMap(nextIngMap);
      })
      .catch((e) => {
        if (cancelled) return;
        // Callers render the empty map as a zero-cost state rather than an
        // error UI, so the failure has to surface here.
        showErrorToast(e, "Recipe costing data failed to load");
        setIngMap({});
        setRecipeMap({});
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [queryClient, signature]);

  return { ingMap, recipeMap, isLoading };
}
