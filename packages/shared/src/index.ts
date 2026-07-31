export {
  LEGACY_SHORTCODE_PREFIX,
  SHORTCODE_CHARS,
  SHORTCODE_PREFIX,
  cookbookShortcode,
  expenseShortcode,
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  mealShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  recipeShortcode,
  shortcodeSchema,
  taskShortcode,
  vendorShortcode,
  generateShortcode,
  parseShortcode,
  extractShortcodeFromScan,
  getShortcodeUrl,
} from "./shortcode";
export type {
  AnyShortcode,
  CookbookShortcode,
  ExpenseShortcode,
  IngredientShortcode,
  InventoryShortcode,
  LocationShortcode,
  MealShortcode,
  ParsedShortcode,
  ProductShortcode,
  ProjectShortcode,
  PurchaseShortcode,
  RecipeShortcode,
  ShortcodeType,
  TaskShortcode,
  VendorShortcode,
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

export {
  ExternalFetchError,
  MAX_EXTERNAL_HTML_BYTES,
  MAX_EXTERNAL_IMAGE_BYTES,
  assertResponseContentType,
  fetchExternalResponse,
  readResponseWithLimit,
  responseBodyWithLimit,
  sanitizeExternalUrl,
  validateExternalHttpUrl,
} from "./external-fetch";
export type { ExternalFetchOptions } from "./external-fetch";
