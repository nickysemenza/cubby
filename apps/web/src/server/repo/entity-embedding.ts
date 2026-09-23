/**
 * Canonical entity-embedding repository barrel.
 *
 * Keep callers on this path while search, refresh/upsert, and cleanup remain
 * independently testable storage responsibilities.
 *
 * `softDeleteEntityEmbeddingsTx` is deliberately NOT re-exported. It is the
 * hand-copyable half of the removal-path invariant, and being reachable from
 * two import paths (here and the direct module) is part of why 21 copies of it
 * accumulated. Removal paths go through `repo/removal`'s `cascadeRemoval`,
 * which derives the cascade from the entity; `repo/merge`'s `finalizeMerge`
 * delegates to the same place.
 */

export {
  findChildTaskEmbeddingRefs,
  findCommercialEmbeddingRefsForExpenses,
  findEmbeddingRefsForPurchases,
  findEmbeddingRefsForVendors,
  findGardenEntryEmbeddingRefsForLocations,
  findGardenEntryEmbeddingRefsForPlantings,
  findInventoryEmbeddingRefsForLocations,
  findInventoryEmbeddingRefsForProducts,
  findMealEmbeddingRefsForRecipes,
  findPlantingEmbeddingRefsForPlants,
  findPlantingEmbeddingRefsForLocations,
  findProductEmbeddingRefsForCategories,
  findRecipeEmbeddingRefsForIngredients,
  findTaskEmbeddingRefsForProducts,
  findTrackerEmbeddingRefsForProjects,
  findTransactionEmbeddingRefsForAccounts,
  findWishEmbeddingRefsForProducts,
  getEntityEmbeddingDeletedAtForRef,
} from "./entity-embedding-cleanup";
export * from "./entity-embedding-refresh";
export * from "./entity-embedding-search";
