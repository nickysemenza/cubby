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
    all: ["recipe"] as const,
  },
  activityType: {
    list: ["activityType", "list"] as const,
    listDue: ["activityType", "listDue"] as const,
    byProduct: ["activityType", "byProduct"] as const,
    autocomplete: ["activityType", "autocomplete"] as const,
  },
  activityEntry: {
    list: ["activityEntry", "list"] as const,
  },
} as const;
