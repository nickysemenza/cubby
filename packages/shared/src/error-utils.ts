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
  WISH_NOT_FOUND: "NOT_FOUND",

  // Constraint violations
  LOCATION_CYCLE_DETECTED: "PRECONDITION_FAILED",
  IMAGE_PRECONDITION_FAILED: "PRECONDITION_FAILED",
  PRODUCT_EXTERNAL_ID_PRECONDITION_FAILED: "PRECONDITION_FAILED",
  LOCATION_HAS_INVENTORY: "PRECONDITION_FAILED",
  LOCATION_HAS_CHILDREN: "PRECONDITION_FAILED",
  PRODUCT_HAS_INVENTORY: "PRECONDITION_FAILED",
  PRODUCT_HAS_EXPENSES: "PRECONDITION_FAILED",
  PRODUCT_HAS_TASKS: "PRECONDITION_FAILED",
  PRODUCT_HAS_PROJECT_USES: "PRECONDITION_FAILED",
  PRODUCT_HAS_PURCHASE_LINKS: "PRECONDITION_FAILED",
  // A tool can't be recorded as used on a project we didn't own it during —
  // acquired after the project ended, or disposed of before it started. Both
  // dates are ledger-derived, so the fix is usually a missing acquisition
  // Expense rather than the edge being wrong.
  TOOL_TIMELINE_CONFLICT: "PRECONDITION_FAILED",
  PRODUCT_HAS_WISH_CANDIDATES: "PRECONDITION_FAILED",
  PRODUCT_HAS_LOCATIONS: "PRECONDITION_FAILED",
  // A product still listed inside a live kit's component list — same shape as
  // PRODUCT_HAS_PURCHASE_LINKS, one hop over into ProductComponent.
  PRODUCT_HAS_KIT_LINKS: "PRECONDITION_FAILED",
  // Caller tried to attach a product as a component of itself.
  PRODUCT_COMPONENT_SELF_REFERENCE: "BAD_REQUEST",
  // Attach-side counterpart of PRODUCT_MERGE_COMPONENT_CYCLE: the DB CHECK only
  // catches the one-hop self-reference, so a multi-hop cycle (A lists B, B
  // lists A several hops down) is only visible by walking the WHOLE live
  // ProductComponent edge set with the proposed new edges projected on top —
  // see findMergeComponentCycle in repo/product/merge.ts, reused (not
  // reimplemented) by attachProductComponents.
  PRODUCT_COMPONENT_CYCLE: "BAD_REQUEST",
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
  // Two products stocked in the SAME location can't both survive a merge (the
  // partial-unique (productId, locationId) index), so their entries are summed
  // — which is only meaningful when the two amounts share a unit. "2 box" plus
  // "3 each" has no honest answer, so the merge refuses instead of inventing
  // one; fix the unit on one entry first.
  PRODUCT_MERGE_INVENTORY_UNIT_MISMATCH: "BAD_REQUEST",
  // Two kits being merged both list the same component, with DIFFERENT
  // quantities. The partial-unique (parentProductId, componentProductId) index
  // lets only one row survive, and picking either quantity invents or destroys
  // units of a real part, so the merge refuses. Equal quantities dedupe
  // silently — there is nothing to lose.
  PRODUCT_MERGE_COMPONENT_QUANTITY_MISMATCH: "BAD_REQUEST",
  // ProductComponent is a Product->Product DAG, so identifying two nodes can
  // make a kit contain itself several hops down (merging a kit into one of its
  // own descendants, or a descendant into its kit). A single-row CHECK only
  // catches the one-hop case; this is the multi-hop one.
  PRODUCT_MERGE_COMPONENT_CYCLE: "BAD_REQUEST",
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

  // AI suggestions: the model answered, but with an id that names no live
  // location. Never surfaced as the model's word — a 5xx, because a suggester
  // ignoring its own candidate roster is a prompt/provider regression worth
  // seeing in Sentry rather than a normal empty result.
  AI_SUGGESTION_UNUSABLE: "INTERNAL_SERVER_ERROR",

  // Image operations
  IMAGE_UPLOAD_FAILED: "INTERNAL_SERVER_ERROR",
  IMAGE_CULL_FAILED: "INTERNAL_SERVER_ERROR",
  IMAGE_IMPORT_FAILED: "INTERNAL_SERVER_ERROR",
  // Attach validation (bad target id, unsupported content type, empty/absent
  // payload) — caller errors, so a 4xx that stays out of Sentry.
  IMAGE_ATTACH_FAILED: "BAD_REQUEST",
} as const;

export type AppErrorReason = keyof typeof AppErrors;
