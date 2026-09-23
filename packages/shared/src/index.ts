export * from "./shortcode";
export { mapRecord, recordKeys } from "./record";
export {
  capitalize,
  humanize,
  screamingSnake,
  type ScreamingSnake,
} from "./text-case";

export { UNRESOLVABLE_ENTITY_FILTER } from "./filter";

export {
  getErrorMessage,
  AppErrors,
  entityNotFoundReason,
} from "./error-utils";
export type { AppErrorReason } from "./error-utils";

export {
  inventoryPlacementValues,
  getCategoryColor,
  getFeatureColor,
  formatCategoryLabel,
} from "./category-theme";
export type { InventoryPlacement, ProductCategory } from "./category-theme";

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

export { isNonFoodCategory } from "./category-theme";
