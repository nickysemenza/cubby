/**
 * Product repository module.
 *
 * Re-exports all product-related repository functions.
 * Import from this file for all product operations.
 */

// Analytics operations
export {
  backfillFoodCategories,
  countProductsNeedingFoodCategory,
  countProductsWithNoImages,
  findDuplicateUniqueProducts,
  findProductsNeedingFoodCategory,
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
  getProductsByShortcodes,
  productList,
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
} from "./lookup";

// Pricing operations
export { backfillProductPrices, findProductsWithStalePrices } from "./pricing";
// Types
export type { ProductDeepDB } from "./types";
