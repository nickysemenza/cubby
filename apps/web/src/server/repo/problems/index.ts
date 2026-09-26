/**
 * Problems repository — public API barrel.
 *
 * Pure detection/query helpers for the Problems page (all DB + WASM access). The
 * service layer (`problems.service.ts`) composes these into the orchestrated
 * per-group scans, `findMaintenanceCounts`, cross-entity deletes, and the
 * re-parse mutation — it never touches the DB directly. Import detectors from
 * `~/server/repo/problems` (this barrel) rather than the individual modules.
 *
 *   PRODUCT     → `detectors-product.ts`   (duplicates, orphans, no-coverage,
 *                                            stocked-but-unpriced, sold-but-
 *                                            still-stocked, better-UPC,
 *                                            coverage pull, usage counts,
 *                                            linked-product ids)
 *   INGREDIENT  → `detectors-ingredient.ts` (no-product, unused aliases,
 *                                            unused ingredients, alias pruning)
 *   COVERAGE    → `detectors-coverage.ts`   (population denominators for the
 *                                            coverage meters — the only module
 *                                            here that counts *healthy* rows)
 *   PURCHASE    → `detectors-purchase.ts`   (charges whose lines don't add up to
 *                                            their stated total — ADVISORY, since
 *                                            a partial refund makes that correct)
 *   RECIPE      → `detectors-recipe.ts`     (parents referencing a soft-deleted
 *                                            sub-recipe while marked fresh —
 *                                            derived-data-on-removal guardrail)
 *   LABELS      → `detectors-label-variants.ts`
 *                                           (one name spelled two ways — in the
 *                                            free-text manufacturer column, or as
 *                                            two `Vendor` roster rows)
 *   EMBEDDING   → `detectors-embedding.ts`  (live entities with no embedding row
 *                                            — invisible to semantic search)
 *   INTEGRITY   → `detectors-integrity.ts`  (live rows pointing at soft-deleted
 *                                            targets, plus Project/Task
 *                                            dependency cycles written out of
 *                                            band)
 *   REPARSE     → `reparse.ts`              (stale-parse detection + apply writes)
 *
 * Every problem item type is the canonical Zod-derived shape from
 * @cubby/schemas/problems; this repo is checked against those rather than
 * re-declaring parallel interfaces.
 */

export { findPartiallyImportedCookbooks } from "./detectors-cookbook";
export { findCoverageTotals } from "./detectors-coverage";
// Embedding-coverage detector (mirror of the orphaned-embedding sweep)
export {
  countEntitiesMissingEmbeddings,
  findEntitiesMissingEmbeddings,
  findEntitiesMissingEmbeddingsPage,
} from "./detectors-embedding";
export {
  findDuplicateFinancialAccountSourceAliases,
  findDuplicateFinancialTransactionSourceRefs,
  findIncompleteStatementImports,
  findInvalidFinancialJson,
  loadAllocationDefectPresenters,
} from "./detectors-financial";
export {
  findIngredientsWithUnusedAliases,
  pruneUnusedAliases,
} from "./detectors-ingredient";
// Schema-wide referential-liveness audit
export {
  countDependencyCycles,
  countReferentialLivenessViolations,
  findDependencyCycles,
  findReferentialLivenessViolations,
} from "./detectors-integrity";
// Name drift (one name, two spellings) — free-text manufacturer + vendor roster
export {
  findDuplicateVendors,
  findManufacturerSpellingVariants,
} from "./detectors-label-variants";
export {
  findDuplicateProductIdentities,
  findLinkedProductIds,
  findOrphanedProducts,
  findProductsWithoutUnitMappings,
  findProductsWithUpcGaps,
  findToolsUsedOutsideOwnership,
  findWeightSoldProducts,
  loadProductsForCoverage,
  loadSoldButStockedPresenterTotals,
  recipeUsageCountsByProduct,
  synthesizeEffectiveMappings,
} from "./detectors-product";
export { findDuplicateSpendCandidates } from "./detectors-purchase";
export { findOpenImportFindings } from "./detectors-import";
// Recipe-centric detectors (derived-data-on-removal guardrail)
export { findParentRecipesWithDeletedSubRecipes } from "./detectors-recipe";
export { loadVendorLogoPresenterCounts } from "./detectors-vendor";
export {
  applyReparsedStaleLines,
  countReparseableLines,
  findStaleIngredientParses,
  type ReparsedStaleLineWrite,
} from "./reparse";
