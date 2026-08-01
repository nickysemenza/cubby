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
  // DOMException is not an Error subclass in every browser/runtime. Keep this
  // structural fallback narrow so browser-generated failures retain the useful
  // message without stringifying arbitrary objects.
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
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
  MEAL_NOT_FOUND: "NOT_FOUND",
  MEAL_RECIPE_NOT_FOUND: "NOT_FOUND",
  BACKGROUND_BATCH_NOT_FOUND: "NOT_FOUND",
  PROJECT_NOT_FOUND: "NOT_FOUND",
  TASK_NOT_FOUND: "NOT_FOUND",
  EXPENSE_NOT_FOUND: "NOT_FOUND",
  VENDOR_NOT_FOUND: "NOT_FOUND",
  PURCHASE_NOT_FOUND: "NOT_FOUND",
  FINANCIAL_ACCOUNT_NOT_FOUND: "NOT_FOUND",
  FINANCIAL_TRANSACTION_NOT_FOUND: "NOT_FOUND",

  // Constraint violations
  LOCATION_CYCLE_DETECTED: "PRECONDITION_FAILED",
  IMAGE_PRECONDITION_FAILED: "PRECONDITION_FAILED",
  LOCATION_HAS_INVENTORY: "PRECONDITION_FAILED",
  LOCATION_HAS_CHILDREN: "PRECONDITION_FAILED",
  PRODUCT_HAS_INVENTORY: "PRECONDITION_FAILED",
  PRODUCT_HAS_EXPENSES: "PRECONDITION_FAILED",
  PRODUCT_HAS_TASKS: "PRECONDITION_FAILED",
  INGREDIENT_HAS_PRODUCTS: "PRECONDITION_FAILED",
  INGREDIENT_HAS_RECIPES: "PRECONDITION_FAILED",
  INGREDIENT_MERGE_INVALID: "BAD_REQUEST",
  PROJECT_HAS_TASKS: "PRECONDITION_FAILED",
  PROJECT_HAS_EXPENSES: "PRECONDITION_FAILED",
  FINANCIAL_ACCOUNT_HAS_TRANSACTIONS: "PRECONDITION_FAILED",
  FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT: "CONFLICT",
  FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT: "CONFLICT",
  FINANCIAL_TRANSACTION_POSTED_DATE_REQUIRED: "BAD_REQUEST",
  // A vendor can't be deleted while charges still point at it — same rule as
  // PROJECT_HAS_EXPENSES, one level up the Vendor ──< Purchase ──< Expense chain.
  VENDOR_HAS_PURCHASES: "PRECONDITION_FAILED",
  // Two charges can't both survive a merge while both carry a non-null orderId:
  // the partial-unique (vendorId, orderId) index makes that a no-op, not a merge.
  PURCHASE_MERGE_ORDER_COLLISION: "BAD_REQUEST",
  // A merge must stay within one vendor — re-pointing a charge across vendors
  // would silently rewrite who was paid.
  PURCHASE_MERGE_VENDOR_MISMATCH: "BAD_REQUEST",
  // project.parentProjectId: arbitrary-depth sub-projects (WBS) — a project
  // can't become its own descendant.
  PROJECT_HAS_CHILDREN: "PRECONDITION_FAILED",
  PROJECT_CYCLE: "BAD_REQUEST",
  // Generic (non-entity-specific): a blockedByIds replacement set contains
  // the entity's own id. Also reused for task.parentTaskId/project.parentProjectId
  // self-reference.
  SELF_DEPENDENCY: "BAD_REQUEST",
  // task.parentTaskId: only one level of subtask nesting is supported.
  TASK_PARENT_IS_SUBTASK: "BAD_REQUEST",
  TASK_HAS_SUBTASKS: "BAD_REQUEST",

  // Conflict/duplicate
  PRODUCT_ALREADY_EXISTS: "CONFLICT",
  // Optimistic-concurrency: the data changed since the client loaded its snapshot.
  INVENTORY_STALE: "CONFLICT",

  // Generic database constraint violations (translated centrally from Postgres
  // error codes — see server/errors/db-errors.ts)
  DUPLICATE_RECORD: "CONFLICT",
  REFERENCED_RECORD_MISSING: "BAD_REQUEST",
  REQUIRED_FIELD_MISSING: "BAD_REQUEST",
  CONSTRAINT_VIOLATION: "BAD_REQUEST",

  // Image operations
  IMAGE_UPLOAD_FAILED: "INTERNAL_SERVER_ERROR",
  IMAGE_CULL_FAILED: "INTERNAL_SERVER_ERROR",
  IMAGE_IMPORT_FAILED: "INTERNAL_SERVER_ERROR",
  // Attach validation (bad target id, unsupported content type, empty/absent
  // payload) — caller errors, so a 4xx that stays out of Sentry.
  IMAGE_ATTACH_FAILED: "BAD_REQUEST",
} as const;

export type AppErrorReason = keyof typeof AppErrors;
