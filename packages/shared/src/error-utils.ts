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
  MEAL_NOT_FOUND: "NOT_FOUND",
  MEAL_RECIPE_NOT_FOUND: "NOT_FOUND",
  BACKGROUND_BATCH_NOT_FOUND: "NOT_FOUND",
  PROJECT_NOT_FOUND: "NOT_FOUND",
  TASK_NOT_FOUND: "NOT_FOUND",
  PURCHASE_NOT_FOUND: "NOT_FOUND",

  // Constraint violations
  LOCATION_CYCLE_DETECTED: "PRECONDITION_FAILED",
  LOCATION_HAS_INVENTORY: "PRECONDITION_FAILED",
  LOCATION_HAS_CHILDREN: "PRECONDITION_FAILED",
  PRODUCT_HAS_INVENTORY: "PRECONDITION_FAILED",
  INGREDIENT_HAS_PRODUCTS: "PRECONDITION_FAILED",
  INGREDIENT_HAS_RECIPES: "PRECONDITION_FAILED",
  INGREDIENT_MERGE_INVALID: "BAD_REQUEST",
  PROJECT_HAS_TASKS: "PRECONDITION_FAILED",
  PROJECT_HAS_PURCHASES: "PRECONDITION_FAILED",
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
