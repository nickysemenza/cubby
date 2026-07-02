export {
  SHORTCODE_CHARS,
  SHORTCODE_PREFIX,
  SHORTCODE_RE,
  locationShortcode,
  productShortcode,
  recipeShortcode,
  generateShortcodeId,
  generateLocationShortcode,
  generateProductShortcode,
  generateRecipeShortcode,
  parseShortcode,
  isValidShortcode,
  extractShortcodeFromScan,
  getShortcodeUrl,
} from "./shortcode";
export type {
  LocationShortcode,
  ProductShortcode,
  RecipeShortcode,
} from "./shortcode";

export {
  getErrorMessage,
  AppErrors,
} from "./error-utils";
export type { AppErrorReason } from "./error-utils";

export {
  productCategoryValues,
  categoryColors,
  getCategoryColor,
  formatCategoryLabel,
  FOOD_CATEGORY,
  isNonFoodCategory,
} from "./category-theme";
export type { ProductCategory } from "./category-theme";

export {
  locationTypeValues,
  locationTypeColors,
  getLocationTypeColor,
} from "./location-type-theme";
export type { LocationType } from "./location-type-theme";

export {
  UNSPECIFIED_MANUFACTURER,
  isMiscProduct,
  getMiscDisplayName,
} from "./constants";
