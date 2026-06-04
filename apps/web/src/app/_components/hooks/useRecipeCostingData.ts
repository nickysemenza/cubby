import type { RecipeOut } from "@cubby/schemas/recipe";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { chunk, ID_CHUNK_SIZE } from "~/misc/array-helpers";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";

type TRPC = ReturnType<typeof useTRPC>;

export type RecipeCostingData = {
  ingMap: Record<string, IngredientWithFoodOut>;
  recipeMap: Record<string, RecipeOut>;
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
export async function loadRecipeCostingData(
  recipes: RecipeOut[],
  api: TRPC,
  queryClient: QueryClient,
): Promise<RecipeCostingData> {
  // 1. Transitive closure of sub-recipes (recipe-as-ingredient). Each fetched
  // recipe may reference further sub-recipes; loop until none are new.
  const fetched: Record<string, RecipeOut> = {};
  const seen = new Set<string>();
  let frontier = collectSubRecipeIds(recipes);
  while (frontier.length > 0) {
    const toFetch = frontier.filter((id) => !seen.has(id));
    for (const id of toFetch) seen.add(id);
    if (toFetch.length === 0) break;

    const chunks = await Promise.all(
      chunk(toFetch.sort(), ID_CHUNK_SIZE).map((ids) =>
        queryClient.ensureQueryData(
          api.recipe.getManyByIDs.queryOptions({ ids }),
        ),
      ),
    );

    const next: string[] = [];
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
        api.ingredient.getManyByIDs.queryOptions({ ids }),
      ),
    ),
  );
  const ingMap = Object.fromEntries(
    chunkResults.flat().map((ing) => [ing.id, ing]),
  ) as Record<string, IngredientWithFoodOut>;

  return { ingMap, recipeMap: fetched };
}

/**
 * React wrapper around {@link loadRecipeCostingData} for the recipe detail view.
 * `ingMap` is `null` until the first load completes (so callers can distinguish
 * "loading" from "loaded but empty"). Fetching is gated on a stable content
 * signature so streaming/refetch re-renders don't restart the work.
 */
export function useRecipeCostingData(recipes: RecipeOut[]): {
  ingMap: Record<string, IngredientWithFoodOut> | null;
  recipeMap: Record<string, RecipeOut>;
  isLoading: boolean;
} {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const [ingMap, setIngMap] = useState<Record<
    string,
    IngredientWithFoodOut
  > | null>(null);
  const [recipeMap, setRecipeMap] = useState<Record<string, RecipeOut>>({});
  const [isLoading, setIsLoading] = useState(false);

  // Read the latest recipes through a ref so the effect can depend on a stable
  // content signature instead of the array reference (which changes every tick).
  const recipesRef = useRef(recipes);
  recipesRef.current = recipes;
  const signature = useMemo(() => buildSignature(recipes), [recipes]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: gated on signature; reads recipes via recipesRef
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
    loadRecipeCostingData(current, api, queryClient)
      .then(({ ingMap: nextIngMap, recipeMap: nextRecipeMap }) => {
        if (cancelled) return;
        setRecipeMap(nextRecipeMap);
        setIngMap(nextIngMap);
      })
      .catch((e: unknown) => {
        console.error("Failed to load recipe costing data:", e);
        if (cancelled) return;
        setIngMap({});
        setRecipeMap({});
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, queryClient, signature]);

  return { ingMap, recipeMap, isLoading };
}

/** Unique ids of sub-recipes (recipe-as-ingredient) referenced by these recipes. */
const collectSubRecipeIds = (recipes: RecipeOut[]): string[] => {
  const ids = new Set<string>();
  for (const r of recipes) {
    for (const s of r.sections) {
      for (const i of s.ingredients) {
        if (i.type === "recipe") ids.add(i.recipe.id);
      }
    }
  }
  return [...ids];
};

/** Unique ids of plain ingredients referenced by these recipes. */
const collectIngredientIds = (recipes: RecipeOut[]): string[] => {
  const ids = new Set<string>();
  for (const r of recipes) {
    for (const s of r.sections) {
      for (const i of s.ingredients) {
        if (i.type === "ingredient") ids.add(i.ingredient.id);
      }
    }
  }
  return [...ids];
};

/**
 * Stable content signature: recipe ids plus each section ingredient's id (and
 * sub-recipe id), so the loader reruns only when linkage actually changes.
 */
const buildSignature = (recipes: RecipeOut[]): string =>
  recipes
    .map(
      (r) =>
        `${r.id}:${r.sections
          .flatMap((s) =>
            s.ingredients.map((i) =>
              i.type === "ingredient" ? i.ingredient.id : `r${i.recipe.id}`,
            ),
          )
          .join("-")}`,
    )
    .join(",");
