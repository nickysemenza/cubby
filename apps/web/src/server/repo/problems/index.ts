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
 *                                            better-UPC, coverage pull, usage
 *                                            counts, linked-product ids)
 *   INGREDIENT  → `detectors-ingredient.ts` (no-product, unused aliases,
 *                                            unused ingredients, alias pruning)
 *   LOCATION    → `detectors-location.ts`   (empty leaves, missing AI description)
 *   RECIPE      → `detectors-recipe.ts`     (parents referencing a soft-deleted
 *                                            sub-recipe while marked fresh —
 *                                            derived-data-on-removal guardrail)
 *   REPARSE     → `reparse.ts`              (stale-parse detection + apply writes)
 *
 * Every problem item type is the canonical Zod-derived shape from
 * @cubby/schemas/problems; this repo is checked against those rather than
 * re-declaring parallel interfaces. `EmptyLocation` and `ProductWithBetterUpcData`
 * are re-exported here for the Problems-page components that import them from this
 * package.
 */

// Ingredient-centric detectors
export {
  findIngredientsWithoutProduct,
  findIngredientsWithUnusedAliases,
  findUnusedIngredients,
  pruneUnusedAliases,
} from "./detectors-ingredient";
// Location-centric detectors (+ EmptyLocation type re-export)
export {
  type EmptyLocation,
  findEmptyLocations,
  findLocationsWithoutAiDescription,
} from "./detectors-location";
// Product-centric detectors (+ ProductWithBetterUpcData type re-export)
export {
  findDuplicateUniqueProducts,
  findLinkedProductIds,
  findOrphanedProducts,
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
