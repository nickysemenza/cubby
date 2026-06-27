import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Centralized query key definitions for React Query.
 * Use these constants to ensure consistency across query invalidations.
 */
export const queryKeys = {
  inventory: {
    all: ["inventory"] as const,
    list: ["inventory", "list"] as const,
  },
  product: {
    // Broad prefix — invalidate every product query (list / search / getByID …)
    // so the deferred product picker (product.search) AND the products table
    // (product.list) both refresh after any product create/update/delete. The
    // picker reads a different key than the table, so a list-only invalidation
    // would leave its options stale.
    all: ["product"] as const,
  },
  location: {
    list: ["location", "list"] as const,
    makeTree: ["location", "makeTree"] as const,
    // Broad prefix — invalidate every location query (list / makeTree / getByID)
    // so persisted valuation rollups are re-read after an inventory/price change.
    all: ["location"] as const,
  },
  ingredient: {
    list: ["ingredient", "list"] as const,
    getByName: ["ingredient", "getByName"] as const,
    // Broad prefix — invalidate every ingredient query (list / getByName /
    // getByID …) after an enrich/merge/update so all consumers re-read.
    all: ["ingredient"] as const,
  },
  problems: {
    // Broad prefix — invalidate every problems query so a fix re-reads whichever
    // cost-grouped detector query (getFast / getCoverage / getUpc) owns the
    // resolved card.
    all: ["problems"] as const,
  },
  search: {
    all: ["search"] as const,
  },
  dashboard: {
    counts: ["dashboard", "counts"] as const,
  },
  debug: {
    timing: ["debug", "timing"] as const,
  },
  recipe: {
    list: ["recipe", "list"] as const,
    getByID: ["recipe", "getByID"] as const,
    // The cookbook browse index lives on the recipe router (`recipe.listCookbooks`),
    // so its key mirrors that tRPC path.
    listCookbooks: ["recipe", "listCookbooks"] as const,
    all: ["recipe"] as const,
  },
  meal: {
    list: ["meal", "list"] as const,
    getByID: ["meal", "getByID"] as const,
    byDateRange: ["meal", "byDateRange"] as const,
    shoppingList: ["meal", "shoppingList"] as const,
    all: ["meal"] as const,
  },
} as const;

export const inventoryMutationInvalidateKeys = [
  queryKeys.inventory.all,
  queryKeys.location.all,
  queryKeys.product.all,
  queryKeys.problems.all,
  queryKeys.search.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const productMutationInvalidateKeys = [
  queryKeys.product.all,
] as const satisfies readonly QueryKey[];

export const productRecipeMutationInvalidateKeys = [
  ...productMutationInvalidateKeys,
  queryKeys.recipe.list,
] as const satisfies readonly QueryKey[];

export const productValuationMutationInvalidateKeys = [
  queryKeys.product.all,
  queryKeys.recipe.list,
  queryKeys.location.all,
] as const satisfies readonly QueryKey[];

export const productLookupMutationInvalidateKeys = [
  queryKeys.product.all,
  queryKeys.problems.all,
  queryKeys.search.all,
] as const satisfies readonly QueryKey[];

export const locationMutationInvalidateKeys = [
  queryKeys.location.list,
] as const satisfies readonly QueryKey[];

export const ingredientMutationInvalidateKeys = [
  queryKeys.ingredient.list,
] as const satisfies readonly QueryKey[];

export const ingredientAllMutationInvalidateKeys = [
  queryKeys.ingredient.all,
] as const satisfies readonly QueryKey[];

export const ingredientProductMutationInvalidateKeys = [
  ...ingredientAllMutationInvalidateKeys,
  ...productMutationInvalidateKeys,
] as const satisfies readonly QueryKey[];

export const ingredientRecipeMutationInvalidateKeys = [
  ...ingredientAllMutationInvalidateKeys,
  queryKeys.recipe.all,
] as const satisfies readonly QueryKey[];

export const ingredientMergeMutationInvalidateKeys = [
  queryKeys.ingredient.all,
  queryKeys.product.all,
  queryKeys.recipe.all,
  queryKeys.meal.all,
  queryKeys.inventory.all,
  queryKeys.location.all,
  queryKeys.problems.all,
  queryKeys.search.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const unusedIngredientCleanupInvalidateKeys = [
  queryKeys.problems.all,
  ...ingredientMutationInvalidateKeys,
] as const satisfies readonly QueryKey[];

export const recipeMutationInvalidateKeys = [
  queryKeys.recipe.list,
] as const satisfies readonly QueryKey[];

export const recipeCookbookMutationInvalidateKeys = [
  queryKeys.recipe.list,
  queryKeys.recipe.listCookbooks,
] as const satisfies readonly QueryKey[];

export const recipeAllMutationInvalidateKeys = [
  queryKeys.recipe.all,
] as const satisfies readonly QueryKey[];

export const problemsMutationInvalidateKeys = [
  queryKeys.problems.all,
] as const satisfies readonly QueryKey[];

export const mealMutationInvalidateKeys = [
  queryKeys.meal.all,
] as const satisfies readonly QueryKey[];

export function normalizeTRPCQueryKey(key: QueryKey): QueryKey {
  if (key.length === 0) return key;
  return Array.isArray(key[0]) ? key : [key];
}

export function invalidateTRPCQueries(
  queryClient: QueryClient,
  keys: readonly QueryKey[],
) {
  for (const key of keys) {
    void queryClient.invalidateQueries({
      queryKey: normalizeTRPCQueryKey(key),
    });
  }
}

export function invalidateAllQueries(queryClient: QueryClient) {
  void queryClient.invalidateQueries();
}

export async function cancelTRPCQueries(
  queryClient: QueryClient,
  keys: readonly QueryKey[],
) {
  await Promise.all(
    keys.map((key) =>
      queryClient.cancelQueries({ queryKey: normalizeTRPCQueryKey(key) }),
    ),
  );
}
