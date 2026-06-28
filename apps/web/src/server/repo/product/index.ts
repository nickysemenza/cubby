/**
 * Product repository — public API barrel.
 *
 * A Product is a purchasable item (a specific SKU or a `misc:` placeholder); it
 * may point to one Ingredient and is loosely linked to one USDA food
 * (`fdc_id`-first, else UPC). See {@link file://../../../../../docs/terminology.md}.
 * Import product operations from `~/server/repo/product` (this barrel).
 *
 *   CRUD      → `crud.ts`      (create / quick-create / update / delete + by-id
 *                               and by-shortcode reads, list)
 *   LOOKUP    → `lookup.ts`    (find by UPC / fuzzy name+manufacturer / food id)
 *   ANALYTICS → `analytics.ts` (category distribution, duplicate + no-image
 *                               detection, audit summaries)
 *   HELPERS   → `helpers.ts`   (foodLookupParamFromProduct: USDA resolution key)
 *
 * Sibling relationships: feeds `inventory` (price → entry `valuation`) and
 * `recipe` costing (unit mappings); linked to `ingredient` and USDA. Update
 * internals (`update-helpers.ts`) and `types.ts` are not re-exported.
 */

// Analytics operations
export {
  findDuplicateUniqueProducts,
  findProductsWithNoImages,
  getCategoryDistribution,
  getProductSummaryForAudit,
} from "./analytics";
// CRUD operations
export {
  createProduct,
  deleteProducts,
  getProductByID,
  getProductByShortcode,
  getProductImagesByProductIds,
  getProductsByShortcodes,
  getProductsForFoodLookup,
  getProductUnitMappingsByProductIds,
  productList,
  productSearch,
  quickCreateProduct,
  updateProduct,
} from "./crud";
// Helpers
export { foodLookupParamFromProduct } from "./helpers";

// Lookup operations
export {
  findProductByNameFuzzyManufacturer,
  findProductByUPC,
  findProductsByFoodIdentifier,
  getFoodLookupsForLinkedProducts,
} from "./lookup";
