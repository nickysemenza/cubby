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
  countProductsWithUPCNoImages,
  findDuplicateUniqueProducts,
  findProductsNeedingFoodCategory,
  findProductsWithUPCNoImages,
  getCategoryDistribution,
} from "./analytics";
// CRUD operations
export {
  createProduct,
  deleteProducts,
  findProductByShortcode,
  getProductByID,
  getProductByShortcode,
  getProductsByShortcodes,
  productList,
  quickCreateProduct,
  updateProduct,
} from "./crud";
// Helpers
export { dbProductToAPI, foodLookupParamFromProduct } from "./helpers";

// Lookup operations
export {
  findProductByNameFuzzyManufacturer,
  findProductByUPC,
  findProductsByFoodIdentifier,
} from "./lookup";

// Pricing operations
export {
  backfillProductPrices,
  findProductsWithStalePrices,
  syncProductPrice,
} from "./pricing";
// Types
export type { ProductDeepDB } from "./types";
