import type { QueryClient, QueryKey } from "@tanstack/react-query";

const entityKey = <TEntity extends string>(entity: TEntity) =>
  [entity] as const;
const procedureKey = <TEntity extends string, TProcedure extends string>(
  entity: TEntity,
  procedure: TProcedure,
) => [entity, procedure] as const;

/**
 * Centralized query key definitions for React Query.
 * Use these constants to ensure consistency across query invalidations.
 */
export const queryKeys = {
  inventory: {
    all: entityKey("inventory"),
    list: procedureKey("inventory", "list"),
  },
  image: {
    all: entityKey("image"),
    list: procedureKey("image", "list"),
  },
  usda: {
    all: entityKey("usda"),
    list: procedureKey("usda", "list"),
  },
  product: {
    // Broad prefix — invalidate every product query (list / search / getByID …)
    // so the deferred product picker (product.search) AND the products table
    // (product.list) both refresh after any product create/update/delete. The
    // picker reads a different key than the table, so a list-only invalidation
    // would leave its options stale.
    all: entityKey("product"),
  },
  location: {
    list: procedureKey("location", "list"),
    makeTree: procedureKey("location", "makeTree"),
    // Broad prefix — invalidate every location query (list / makeTree / getByID)
    // so persisted valuation rollups are re-read after an inventory/price change.
    all: entityKey("location"),
  },
  ingredient: {
    list: procedureKey("ingredient", "list"),
    getByName: procedureKey("ingredient", "getByName"),
    // Broad prefix — invalidate every ingredient query (list / getByName /
    // getByID …) after an enrich/merge/update so all consumers re-read.
    all: entityKey("ingredient"),
  },
  problems: {
    // Broad prefix — invalidate every problems query so a fix re-reads whichever
    // cost-grouped detector query (getFast / getCoverage / getUpc / getTracker)
    // owns the resolved card.
    all: entityKey("problems"),
  },
  search: {
    all: entityKey("search"),
  },
  dashboard: {
    counts: procedureKey("dashboard", "counts"),
  },
  debug: {
    timing: procedureKey("debug", "timing"),
  },
  recipe: {
    list: procedureKey("recipe", "list"),
    getByID: procedureKey("recipe", "getByID"),
    // The cookbook browse index lives on the recipe router (`recipe.listCookbooks`),
    // so its key mirrors that tRPC path.
    listCookbooks: procedureKey("recipe", "listCookbooks"),
    all: entityKey("recipe"),
  },
  cookbook: {
    all: procedureKey("recipe", "listCookbooks"),
  },
  meal: {
    list: procedureKey("meal", "list"),
    getByID: procedureKey("meal", "getByID"),
    byDateRange: procedureKey("meal", "byDateRange"),
    shoppingList: procedureKey("meal", "shoppingList"),
    all: entityKey("meal"),
  },
  project: {
    list: procedureKey("project", "list"),
    getByID: procedureKey("project", "getByID"),
    dashboard: procedureKey("project", "dashboard"),
    all: entityKey("project"),
  },
  task: {
    list: procedureKey("task", "list"),
    all: entityKey("task"),
  },
  purchase: {
    list: procedureKey("purchase", "list"),
    all: entityKey("purchase"),
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
  // Recipe cost inputs changed → meal cost/calorie rollups (read from
  // recipe.totals) go stale; meal queries are cheap to blanket-invalidate.
  queryKeys.meal.all,
] as const satisfies readonly QueryKey[];

export const productValuationMutationInvalidateKeys = [
  queryKeys.product.all,
  queryKeys.recipe.list,
  queryKeys.location.all,
  // Recipe cost inputs changed → refresh meal cost/calorie rollups.
  queryKeys.meal.all,
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
  // Recipe cost/calorie inputs changed → refresh meal rollups.
  queryKeys.meal.all,
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
  // Recipe totals changed → refresh meal cost/calorie rollups.
  queryKeys.meal.all,
] as const satisfies readonly QueryKey[];

export const problemsMutationInvalidateKeys = [
  queryKeys.problems.all,
] as const satisfies readonly QueryKey[];

export const mealMutationInvalidateKeys = [
  queryKeys.meal.all,
] as const satisfies readonly QueryKey[];

// Task/purchase mutations also invalidate `project.all`: the dashboard and
// project rollups (spent/progress) aggregate over them.
export const projectMutationInvalidateKeys = [
  queryKeys.project.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const taskMutationInvalidateKeys = [
  queryKeys.task.all,
  queryKeys.project.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const purchaseMutationInvalidateKeys = [
  queryKeys.purchase.all,
  queryKeys.project.all,
  queryKeys.dashboard.counts,
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
