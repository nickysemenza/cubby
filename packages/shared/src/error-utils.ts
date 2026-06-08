/**
 * Portable error utilities (no tRPC dependency).
 */

/** Safely extract error message from unknown error type. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unknown error occurred";
}

/**
 * App error definitions: key = reason, value = HTTP-style error code string.
 * The web app's `createAppError` casts these to tRPC codes, but the map
 * itself is framework-agnostic so it can be used in any environment.
 */
export const AppErrors = {
  // Auth
  UNAUTHORIZED: "UNAUTHORIZED",

  // Entity not found
  RECIPE_NOT_FOUND: "NOT_FOUND",
  COOKBOOK_NOT_FOUND: "NOT_FOUND",
  INVENTORY_NOT_FOUND: "NOT_FOUND",
  IMAGE_NOT_FOUND: "NOT_FOUND",
  PRODUCT_NOT_FOUND: "NOT_FOUND",
  LOCATION_NOT_FOUND: "NOT_FOUND",
  INGREDIENT_NOT_FOUND: "NOT_FOUND",

  // Constraint violations
  LOCATION_CYCLE_DETECTED: "PRECONDITION_FAILED",
  LOCATION_HAS_INVENTORY: "PRECONDITION_FAILED",
  LOCATION_HAS_CHILDREN: "PRECONDITION_FAILED",
  PRODUCT_HAS_INVENTORY: "PRECONDITION_FAILED",
  INGREDIENT_HAS_PRODUCTS: "PRECONDITION_FAILED",
  INGREDIENT_HAS_RECIPES: "PRECONDITION_FAILED",

  // Conflict/duplicate
  PRODUCT_ALREADY_EXISTS: "CONFLICT",

  // Generic database constraint violations (translated centrally from Postgres
  // error codes — see server/errors/db-errors.ts)
  DUPLICATE_RECORD: "CONFLICT",
  REFERENCED_RECORD_MISSING: "BAD_REQUEST",
  REQUIRED_FIELD_MISSING: "BAD_REQUEST",
  CONSTRAINT_VIOLATION: "BAD_REQUEST",

  // Image operations
  IMAGE_LIST_FAILED: "INTERNAL_SERVER_ERROR",
  IMAGE_UPLOAD_FAILED: "INTERNAL_SERVER_ERROR",
  IMAGE_GET_FAILED: "INTERNAL_SERVER_ERROR",
  IMAGE_CULL_FAILED: "INTERNAL_SERVER_ERROR",
  IMAGE_IMPORT_FAILED: "INTERNAL_SERVER_ERROR",
} as const;

export type AppErrorReason = keyof typeof AppErrors;
