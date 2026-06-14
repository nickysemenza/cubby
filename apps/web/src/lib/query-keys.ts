/**
 * Centralized query key definitions for React Query.
 * Use these constants to ensure consistency across query invalidations.
 */
export const queryKeys = {
  inventory: {
    list: ["inventory", "list"] as const,
  },
  product: {
    list: ["product", "list"] as const,
  },
  location: {
    list: ["location", "list"] as const,
  },
  ingredient: {
    list: ["ingredient", "list"] as const,
    getByName: ["ingredient", "getByName"] as const,
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
    dependencyGraph: ["recipe", "getDependencyGraph"] as const,
    ingredientUsage: ["recipe", "getIngredientUsage"] as const,
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
