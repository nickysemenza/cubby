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
  recipe: {
    list: ["recipe", "list"] as const,
    getByID: ["recipe", "getByID"] as const,
    // Cookbooks are derived from recipes (grouped by SourceData), so the browse
    // index lives on the recipe router — its key mirrors that tRPC path.
    listCookbooks: ["recipe", "listCookbooks"] as const,
    all: ["recipe"] as const,
  },
} as const;
