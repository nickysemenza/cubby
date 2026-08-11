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

export {
  findDuplicateUniqueProducts,
  findProductsWithNoImages,
  getCategoryDistribution,
  getProductExternalIdSourceOptions,
  getProductManufacturerOptions,
  getProductSummaryForAudit,
  getProductsSharingTags,
  getProductTagOptions,
} from "./analytics";
export {
  createProduct,
  deleteProducts,
  getProductByID,
  getProductByShortcode,
  getProductImagesByProductIds,
  getProductPickerItemsByIds,
  getProductsByShortcodes,
  getProductsForFoodLookup,
  getProductUnitMappingsByProductIds,
  patchProductExternalIds,
  productList,
  productSearch,
  quickCreateProduct,
  updateProduct,
} from "./crud";
// Discard (a $0, negative-quantity exit — see the module doc for why it
// carries no Purchase and how it treats the shelf).
export { discardProductUnits } from "./discard";
export { foodLookupParamFromProduct } from "./helpers";
export {
  findProductByNameFuzzyManufacturer,
  findProductByUPC,
  findProductsByFoodIdentifier,
  getFoodLookupsForLinkedProducts,
} from "./lookup";
// Merge (fold duplicate SKUs into one survivor). `PRODUCT_MERGE_EDGE_POLICY`
// is deliberately NOT re-exported here — the lifecycle registry imports it from
// `./merge` directly, the same way it reaches every other entity's policy.
export { mergeProducts, previewMergeProducts } from "./merge";
export { getProductMovementTimeline } from "./movement-timeline";
