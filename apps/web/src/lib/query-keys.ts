/**
 * Centralized query key definitions for React Query.
 * Use these constants to ensure consistency across query invalidations.
 */
export const queryKeys = {
  inventory: {
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
  },
  problems: {
    // Broad prefix — invalidate every problems query so a fix re-reads whichever
    // cost-grouped detector query (getFast / getCoverage / getAliases /
    // getParses / getUpc) owns the resolved card, plus the badge's combined
    // getAllProblems scan. The page loads the groups, not getAllProblems.
    all: ["problems"] as const,
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
