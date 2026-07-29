/**
 * Problems repository — public API barrel.
 *
 * Pure detection/query helpers for the Problems page (all DB + WASM access). The
 * service layer (`problems.service.ts`) composes these into the orchestrated
 * findAllProblems / findMaintenanceCounts scans, cross-entity deletes, and the
 * re-parse mutation — it never touches the DB directly. Import detectors from
 * `~/server/repo/problems` (this barrel) rather than the individual modules.
 *
 *   PRODUCT     → `detectors-product.ts`   (duplicates, orphans, no-coverage,
 *                                            stocked-but-unpriced, better-UPC,
 *                                            coverage pull, usage counts,
 *                                            linked-product ids)
 *   INGREDIENT  → `detectors-ingredient.ts` (no-product, unused aliases,
 *                                            unused ingredients, alias pruning)
 *   LOCATION    → `detectors-location.ts`   (empty leaves, missing AI description,
 *                                            stocked bins overdue for a recount)
 *   INVENTORY   → `detectors-inventory.ts`  (never-verified entries, items parked
 *                                            in the global "Unknown" location)
 *   COVERAGE    → `detectors-coverage.ts`   (population denominators for the
 *                                            coverage meters — the only module
 *                                            here that counts *healthy* rows)
 *   RECIPE      → `detectors-recipe.ts`     (parents referencing a soft-deleted
 *                                            sub-recipe while marked fresh —
 *                                            derived-data-on-removal guardrail)
 *   LABELS      → `detectors-label-variants.ts`
 *                                           (one brand spelled two ways in the
 *                                            free-text manufacturer column)
 *   EMBEDDING   → `detectors-embedding.ts`  (live entities with no embedding row
 *                                            — invisible to semantic search)
 *   REPARSE     → `reparse.ts`              (stale-parse detection + apply writes)
 *
 * Every problem item type is the canonical Zod-derived shape from
 * @cubby/schemas/problems; this repo is checked against those rather than
 * re-declaring parallel interfaces. `EmptyLocation` and `ProductWithBetterUpcData`
 * are re-exported here for the Problems-page components that import them from this
 * package.
 */

// Population counts behind the coverage meters (the "M" in "N of M")
export { findCoverageTotals } from "./detectors-coverage";
// Embedding-coverage detector (mirror of the orphaned-embedding sweep)
export {
  countEntitiesMissingEmbeddings,
  findEntitiesMissingEmbeddings,
} from "./detectors-embedding";
// Ingredient-centric detectors
export {
  findIngredientsWithoutProduct,
  findIngredientsWithUnusedAliases,
  findUnusedIngredients,
  pruneUnusedAliases,
} from "./detectors-ingredient";
// Inventory-centric detectors (recount staleness)
export {
  findNeverVerifiedInventory,
  findUnknownParkedItems,
} from "./detectors-inventory";
// Free-text brand-label drift (one name, two spellings)
export { findManufacturerSpellingVariants } from "./detectors-label-variants";
// Location-centric detectors (+ EmptyLocation type re-export)
export {
  type EmptyLocation,
  findEmptyLocations,
  findLocationsWithoutAiDescription,
  findStaleLocations,
} from "./detectors-location";
// Product-centric detectors (+ ProductWithBetterUpcData type re-export)
export {
  findDuplicateUniqueProducts,
  findLinkedProductIds,
  findOrphanedProducts,
  findProductsMissingPrice,
  findProductsWithoutMappings,
  findProductsWithUpcGaps,
  loadProductsForCoverage,
  type ProductWithBetterUpcData,
  recipeUsageCountsByProduct,
  synthesizeEffectiveMappings,
} from "./detectors-product";
// Recipe-centric detectors (derived-data-on-removal guardrail)
export {
  findParentRecipesWithDeletedSubRecipes,
  type StaleParentRecipe,
} from "./detectors-recipe";
// Stale-parse detection + re-parse write path
export {
  applyReparsedStaleLines,
  countReparseableLines,
  findStaleIngredientParses,
  type ReparsedStaleLineWrite,
} from "./reparse";
