import { mapRecord } from "./record";
import { SHORTCODE_TYPES, type ShortcodeType } from "./shortcode";
import { screamingSnake, type ScreamingSnake } from "./text-case";
/**
 * Portable error utilities with no transport dependency.
 */

import { z } from "zod";

const errorMessageSchema = z.object({ message: z.string() });

/** Safely extract error message from unknown error type. */
export function getErrorMessage<TError>(error: TError): string {
  if (error instanceof Error) {
    return error.message;
  }
  const stringValue = z.string().safeParse(error);
  if (stringValue.success) {
    return stringValue.data;
  }
  // DOMException is not an Error subclass in every browser/runtime. Keep this
  // structural fallback narrow so browser-generated failures retain the useful
  // message without stringifying arbitrary objects.
  const messageValue = errorMessageSchema.safeParse(error);
  if (messageValue.success) {
    return messageValue.data.message;
  }
  return "An unknown error occurred";
}

/** `product` → `PRODUCT_NOT_FOUND`, keyed and typed per entity. */
export const entityNotFoundReason = <T extends ShortcodeType>(
  entity: T,
): `${ScreamingSnake<T>}_NOT_FOUND` => `${screamingSnake(entity)}_NOT_FOUND`;

const ENTITY_NOT_FOUND_ERRORS = mapRecord(
  SHORTCODE_TYPES.map(entityNotFoundReason),
  () => "NOT_FOUND" as const,
);

/**
 * App error definitions: key = reason, value = HTTP-style error code string.
 * The web app's `createAppError` exposes these as transport-neutral codes, so
 * the map can be used in any environment.
 */
export const AppErrors = {
  // Auth
  UNAUTHORIZED: "UNAUTHORIZED",

  // Entity not found — one `<ENTITY>_NOT_FOUND` per shortcode entity, derived
  // from the registry so a new entity gets its reason without a line here.
  ...ENTITY_NOT_FOUND_ERRORS,
  MEAL_RECIPE_NOT_FOUND: "NOT_FOUND",
  BACKGROUND_BATCH_NOT_FOUND: "NOT_FOUND",

  // Constraint violations
  LOCATION_CYCLE_DETECTED: "PRECONDITION_FAILED",
  IMAGE_PRECONDITION_FAILED: "PRECONDITION_FAILED",
  PRODUCT_EXTERNAL_ID_PRECONDITION_FAILED: "PRECONDITION_FAILED",
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
  // A book product that a Cookbook claims as its physical copy. Unlink from
  // the cookbook page first; the cookbook and its recipes outlive the copy.
  PRODUCT_HAS_COOKBOOKS: "PRECONDITION_FAILED",
  // A product still listed inside a live kit's component list — same shape as
  // PRODUCT_HAS_PURCHASE_LINKS, one hop over into ProductComponent.
  PRODUCT_HAS_KIT_LINKS: "PRECONDITION_FAILED",
  // A Product that exists and is live, but whose `category` the relation it is
  // being attached to does not accept — today only `ProjectToolUsage`, which
  // takes a category that grants the project-resource capability (see
  // `productCategoryFeatureCapabilities`) and nothing else.
  //
  // Split out of PRODUCT_NOT_FOUND, which every one of those gates used to
  // throw. The code LIED: it sent a caller hunting for a typo in a shortcode
  // that resolves perfectly well, when the fix is to change the product's
  // category (or attach a different product). "Doesn't exist" and "wrong kind"
  // are different problems with different fixes, so they are different reasons.
  PRODUCT_CATEGORY_INELIGIBLE: "PRECONDITION_FAILED",
  PRODUCT_CATEGORY_NOT_FOUND: "NOT_FOUND",
  // `attach_entity` was handed a `quantity` for a parent whose relation carries
  // none. Collapsing three attach tools into one converted three compile-time
  // input schemas into one runtime check; this is that check having something
  // specific to say rather than the field being silently ignored.
  RELATION_QUANTITY_UNSUPPORTED: "BAD_REQUEST",
  LIST_SORT_FIELD_UNSUPPORTED: "BAD_REQUEST",
  LIST_GROUP_BY_FIELD_UNSUPPORTED: "BAD_REQUEST",
  // `ai.suggestFields` was asked for a target that isn't declared
  // `control.suggest` on the entity's manifest.
  SUGGEST_FIELD_UNKNOWN: "BAD_REQUEST",
  SUGGEST_FIELD_FORBIDDEN: "BAD_REQUEST",
  // Caller tried to attach a product as a component of itself.
  PRODUCT_COMPONENT_SELF_REFERENCE: "BAD_REQUEST",
  // Attach-side counterpart of PRODUCT_MERGE_COMPONENT_CYCLE: the DB CHECK only
  // catches the one-hop self-reference, so a multi-hop cycle (A lists B, B
  // lists A several hops down) is only visible by walking the WHOLE live
  // ProductComponent edge set with the proposed new edges projected on top —
  // see findMergeComponentCycle in repo/product/merge.ts, reused (not
  // reimplemented) by attachProductComponents.
  PRODUCT_COMPONENT_CYCLE: "BAD_REQUEST",
  // A barcode that is not 8-14 digits. The repository refuses it rather than
  // dropping it, because `lpad(x, 14, '0')` would TRUNCATE an over-long value
  // into some other product's barcode, and a silently discarded identifier is
  // invisible downstream. Enforced again by
  // `ProductExternalId_gtin_digits_check`.
  PRODUCT_GTIN_INVALID: "BAD_REQUEST",
  // A raw scanner value (`{ kind: "scan" }`) that names nothing stockable: not
  // a Cubby label, barcode or ISBN, or a label for the wrong entity. The
  // message is the same sentence the web scanner shows.
  SCAN_CODE_UNRECOGNIZED: "BAD_REQUEST",
  INGREDIENT_HAS_RECIPES: "PRECONDITION_FAILED",
  // A merge that names its own keeper among the rows to merge away. One code
  // for all four merges: the resolver refuses the whole call rather than
  // silently dropping the keeper from the loser set, because "merged 3" while
  // only 2 rows moved is a result a caller cannot tell apart from a real one.
  MERGE_SELF_REFERENCE: "BAD_REQUEST",
  PROJECT_HAS_TASKS: "PRECONDITION_FAILED",
  PROJECT_HAS_EXPENSES: "PRECONDITION_FAILED",
  FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT: "CONFLICT",
  // Two refusals that are business rules rather than FK edges, so they cannot
  // live in an edge policy. Both previously shared the generic
  // CONSTRAINT_VIOLATION, which left callers unable to tell them apart — or to
  // tell either apart from any other constraint failure.
  LOCATION_IS_ROOT: "PRECONDITION_FAILED",
  PURCHASE_NOT_EMPTY: "PRECONDITION_FAILED",
  FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT: "CONFLICT",
  // A declared `block` edge of a policy-driven delete still has live rows.
  ENTITY_DELETE_BLOCKED: "PRECONDITION_FAILED",
  LEDGER_SOURCE_CLAIM_CONFLICT: "CONFLICT",
  FINANCIAL_TRANSACTION_POSTED_DATE_REQUIRED: "BAD_REQUEST",
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
  // Different ISBNs name different physical editions or formats. Retaining
  // both as secondary barcodes would turn two editions into one Product.
  PRODUCT_MERGE_DISTINCT_ISBNS: "BAD_REQUEST",
  // project.parentProjectId: arbitrary-depth sub-projects (WBS) — a project
  // can't become its own descendant.
  PROJECT_CYCLE: "BAD_REQUEST",
  // ProjectDependency and TaskDependency are DAGs. The repository checks the
  // whole projected graph under a per-family transaction lock before replace.
  DEPENDENCY_CYCLE: "BAD_REQUEST",
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
  // A long-running external logo fetch raced a vendor website edit.
  VENDOR_STALE: "CONFLICT",

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

  // A write COMMITTED but the read that builds its response failed. Its own
  // reason so the message can carry the new id and tell the caller not to
  // retry the create: an agent that sees a plain 5xx on `create` re-sends it
  // and mints a duplicate (seen on a product create whose post-commit
  // ProductImage query failed transiently).
  WRITE_COMMITTED_READBACK_FAILED: "INTERNAL_SERVER_ERROR",

  // Image operations
  IMAGE_UPLOAD_FAILED: "INTERNAL_SERVER_ERROR",
  IMAGE_CULL_FAILED: "INTERNAL_SERVER_ERROR",
  IMAGE_IMPORT_FAILED: "INTERNAL_SERVER_ERROR",
  // Attach validation (bad target id, unsupported content type, empty/absent
  // payload) — caller errors, so a 4xx that stays out of Sentry.
  IMAGE_ATTACH_FAILED: "BAD_REQUEST",
} as const;

export type AppErrorReason = keyof typeof AppErrors;
