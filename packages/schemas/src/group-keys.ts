// Leaf module: entity declarations import these sentinels, so it must not
// import anything that reaches generated output (`pnpm generate` runs before
// that output exists on a fresh checkout).
export const PRODUCT_UNCLASSIFIED_GROUP_KEY = "__unclassified__";
export const LOCATION_UNSPECIFIED_GROUP_KEY = "__unspecified__";
