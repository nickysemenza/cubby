import { z } from "zod";
import { entitySchema } from "./entity";
import {
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
  taskShortcode,
  vendorShortcode,
} from "./identifiers";

/**
 * Serializable shapes for the entity-integrity system.
 *
 * This module holds *shapes only* — no Drizzle, no column objects. The
 * instances that key off `INCOMING_EDGES` (edge semantics, operation policies)
 * live server-side in `apps/web/src/server/db`, so they keep the compile-time
 * key exhaustiveness `IncomingEdgeMap` provides; the client receives them as
 * data through the `entityIntegrity.catalog` procedure.
 *
 * Constants elsewhere are written `as const satisfies <inferred type>` and
 * `.parse()`d in drift tests. Nothing here parses on client import.
 */

/**
 * `${pgTable name}.${column name}` — e.g. `"PurchaseImage.imageId"`. The same
 * identifier `INCOMING_EDGES` keys on, but validated as a string rather than
 * derived from a Drizzle column, so it can cross the wire.
 */
export const edgeKeySchema = z
  .string()
  .regex(
    /^[A-Z][A-Za-z0-9_]*\.[a-z][A-Za-z0-9_]*$/,
    "expected `Table.column`, e.g. `PurchaseImage.imageId`",
  )
  // The test fixture generator can't synthesize a string matching a regex, so
  // hand it one real edge key. See `mockValueHint` in lib/test/mock-schema.ts.
  .meta({ mockValue: "PurchaseImage.imageId" });
export type EdgeKey = z.infer<typeof edgeKeySchema>;

/**
 * What an incoming edge *means*, independent of what any one operation does
 * about it. Stable: a role never encodes delete/merge behavior (that's an
 * `OperationDisposition`), so the same edge can block one operation and be
 * re-pointed by another without its role changing.
 */
export const edgeRoleSchema = z.enum([
  /** A dependent entity the target owns outright; deleting the target deletes it. */
  "owned-child",
  /** A join row linking two independently-owned entities. */
  "association",
  /** A structural part the target is made of, meaningless on its own. */
  "composition",
  /** Authored annotation. Says nothing about whether the target was ever real or owned. */
  "metadata",
  /** Evidence the target was actually acquired — inventory, spend. */
  "acquisition",
  /** Durable work history referencing the target. */
  "history",
  /** A parent/child pointer within the target's own tree. */
  "hierarchy",
  /** A blocks/blocked-by pointer between two rows of the same table. */
  "dependency",
  /** What is physically held inside the target. */
  "contents",
  /** An attached photo or document. */
  "media",
  /** A money row rolled up under the target. */
  "ledger",
  /** A vendor charge recorded against the target. */
  "transaction",
  /** A pointer to the target from another entity's own record. */
  "reference",
  /** The target being consumed or cited by something else. */
  "usage",
]);
export type EdgeRole = z.infer<typeof edgeRoleSchema>;

/**
 * Whether a live source row is allowed to point at a soft-deleted target.
 *
 * Nearly every edge is `must-target-live` — that's the invariant the
 * referential-liveness auditor checks. An `allow-target-deleted` edge must say
 * why, because it opts a real FK out of that audit permanently.
 */
export const edgeLivenessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("must-target-live") }),
  z.object({
    kind: z.literal("allow-target-deleted"),
    reason: z.string().min(1),
  }),
]);
export type EdgeLiveness = z.infer<typeof edgeLivenessSchema>;

export const edgeSemanticsSchema = z.object({
  role: edgeRoleSchema,
  /** Short noun phrase naming the source rows — e.g. "inventory entries". */
  label: z.string().min(1),
  /** One sentence: what this edge represents in the domain. */
  description: z.string().min(1),
  liveness: edgeLivenessSchema,
});
export type EdgeSemantics = z.infer<typeof edgeSemanticsSchema>;

/**
 * The normalized shape of what an operation does to one incoming edge. `code`
 * is the operation's own stable disposition slug (`"block-live-inventory"`),
 * preserved verbatim so the existing per-repo vocabulary survives; `effect` is
 * the small closed set the UI and impact previews reason over.
 */
export const operationEffectSchema = z.enum([
  "block",
  "soft-delete",
  "hard-delete",
  "detach",
  "repoint",
  "move-dedupe",
  "preserve",
]);
export type OperationEffect = z.infer<typeof operationEffectSchema>;

export const operationDispositionSchema = z.object({
  code: z.string().min(1),
  effect: operationEffectSchema,
  description: z.string().min(1),
});
export type OperationDisposition = z.infer<typeof operationDispositionSchema>;

/**
 * One hop along a relationship's FK path. `outgoing` walks the FK from the
 * table that holds the column toward the table it points at; `incoming` walks
 * it backwards, from the pointed-at table to the holder. A path mixes both:
 * recipe → recipe runs `RecipeSection.recipeId` incoming, then
 * `RecipeSectionIngredient.sectionId` incoming, then
 * `RecipeSectionIngredient.ingredientId` outgoing, then `Ingredient.recipeId`
 * outgoing.
 */
export const relationshipPathStepSchema = z.object({
  edge: edgeKeySchema,
  direction: z.enum(["outgoing", "incoming"]),
});
export type RelationshipPathStep = z.infer<typeof relationshipPathStepSchema>;

/**
 * How a declared logical relationship is actually realized in storage.
 *
 * - `local-path` — one or more real FK hops. Verified end-to-end against
 *   Drizzle metadata: every step must be a real FK, the steps must chain, and
 *   the last one must land on the declared target's table.
 * - `unconstrained` — a real relationship the app walks, with no DB-level FK
 *   to verify (`Location.parentId`). Names the edge, which must itself be
 *   marked `unconstrained` in `INCOMING_EDGES`.
 * - `external` — a link to a system with no local table. Names the source
 *   columns that carry it.
 */
export const relationshipProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local-path"),
    steps: z.array(relationshipPathStepSchema).min(1),
  }),
  z.object({
    kind: z.literal("unconstrained"),
    edge: edgeKeySchema,
  }),
  z.object({
    kind: z.literal("external"),
    system: z.string().min(1),
    /** Every column that can carry the link, in resolution order. */
    sourceColumns: z.array(edgeKeySchema).min(1),
  }),
]);
export type RelationshipProvenance = z.infer<
  typeof relationshipProvenanceSchema
>;

export const entityRelationshipSchema = z.object({
  /** Stable, unique within the source entity — e.g. `"sub-recipes"`. */
  key: z.string().min(1),
  label: z.string().min(1),
  target: entitySchema,
  provenance: relationshipProvenanceSchema,
});
export type EntityRelationship = z.infer<typeof entityRelationshipSchema>;

/** What removal paths an entity supports, for the lifecycle registry and UI. */
export const entityLifecycleSchema = z.object({
  delete: z
    .object({
      mode: z.enum(["soft", "hard"]),
      /** Whether the delete accepts more than one id at a time. */
      bulk: z.boolean(),
    })
    .nullable(),
  merge: z.boolean(),
});
export type EntityLifecycle = z.infer<typeof entityLifecycleSchema>;

/**
 * One physical incoming edge, flattened for the wire. `INCOMING_EDGES` holds
 * Drizzle column objects, which cannot be serialized or validated — this is the
 * projection of them the client actually gets.
 */
export const physicalEdgeSchema = z.object({
  edgeKey: edgeKeySchema,
  /** The entity whose `id` this edge points at. */
  targetEntity: entitySchema,
  sourceTable: z.string().min(1),
  sourceColumn: z.string().min(1),
  /** False when the relationship is real but carries no DB-level FK constraint. */
  constrained: z.boolean(),
  semantics: edgeSemanticsSchema,
});
export type PhysicalEdge = z.infer<typeof physicalEdgeSchema>;

/** Every disposition one operation declares, keyed by edge. */
export const lifecycleOperationSchema = z.object({
  entity: entitySchema,
  operation: z.enum(["delete", "merge"]),
  dispositions: z.array(
    z.object({
      edgeKey: edgeKeySchema,
      disposition: operationDispositionSchema,
    }),
  ),
});
export type LifecycleOperation = z.infer<typeof lifecycleOperationSchema>;

/**
 * The static architecture surface behind `/entities?tab=integrity`. Pure
 * projection of compile-time constants — the procedure that serves it runs no
 * queries at all.
 */
export const integrityCatalogSchema = z.object({
  entities: z.array(
    z.object({
      entity: entitySchema,
      dbTable: z.string().nullable(),
      relationships: z.array(entityRelationshipSchema),
      lifecycle: entityLifecycleSchema,
      incomingEdges: z.array(physicalEdgeSchema),
    }),
  ),
  operations: z.array(lifecycleOperationSchema),
  /** Denominators for the tab's summary metrics. */
  coverage: z.object({
    relationships: z.number().int(),
    incomingEdges: z.number().int(),
    auditedEdges: z.number().int(),
    exemptEdges: z.number().int(),
    operations: z.number().int(),
  }),
});
export type IntegrityCatalog = z.infer<typeof integrityCatalogSchema>;

// ---------------------------------------------------------------------------
// Operation impact previews
// ---------------------------------------------------------------------------

/**
 * One consequence of running an operation: a blocker, a change it will make, or
 * a side effect it will trigger.
 *
 * `total` is the count across all selected targets; `byTargetId` breaks it down
 * so a bulk delete can say which of the seven products is the one with
 * inventory. `edgeKey` is present when the item comes from a declared incoming
 * edge, and absent for consequences that aren't edges at all (a recompute, a
 * cache invalidation, an audit entry).
 */
export const impactItemSchema = z.object({
  code: z.string().min(1),
  effect: operationEffectSchema,
  edgeKey: edgeKeySchema.optional(),
  label: z.string().min(1),
  description: z.string().min(1),
  total: z.number().int().nonnegative(),
  byTargetId: z.record(z.string(), z.number().int().nonnegative()),
});
export type ImpactItem = z.infer<typeof impactItemSchema>;

/** Entities whose delete has a preview planner. */
export const previewDeleteEntitySchema = z.enum([
  "product",
  "recipe",
  "ingredient",
  "cookbook",
  "meal",
  "location",
  "project",
  "task",
  "vendor",
  "purchase",
  "expense",
  "inventory",
  "image",
]);
export type PreviewDeleteEntity = z.infer<typeof previewDeleteEntitySchema>;

/** Entities that support merge. */
export const previewMergeEntitySchema = z.enum([
  "ingredient",
  "vendor",
  "purchase",
]);
export type PreviewMergeEntity = z.infer<typeof previewMergeEntitySchema>;

const previewDeleteInput = <const E extends PreviewDeleteEntity>(
  entity: E,
  idSchema: z.ZodType<string, string>,
) =>
  z.object({
    operation: z.literal("delete"),
    entity: z.literal(entity),
    ids: z.array(idSchema).min(1).max(200),
  });

const previewMergeInput = <const E extends PreviewMergeEntity>(
  entity: E,
  idSchema: z.ZodType<string, string>,
) =>
  z
    .object({
      operation: z.literal("merge"),
      entity: z.literal(entity),
      /** Omit for candidate ranking; supply it for the final preview. */
      keepId: idSchema.optional(),
      mergeIds: z.array(idSchema).min(1).max(200),
    })
    .refine((v) => new Set(v.mergeIds).size === v.mergeIds.length, {
      message: "mergeIds must be distinct",
      path: ["mergeIds"],
    })
    .refine((v) => !v.keepId || !v.mergeIds.includes(v.keepId), {
      message: "keepId cannot also appear in mergeIds",
      path: ["keepId"],
    });

export const previewOperationInputSchema = z.union([
  previewDeleteInput("product", productShortcode),
  previewDeleteInput("recipe", recipeShortcode),
  previewDeleteInput("ingredient", ingredientShortcode),
  previewDeleteInput("cookbook", cookbookShortcode),
  previewDeleteInput("meal", mealShortcode),
  previewDeleteInput("location", locationShortcode),
  previewDeleteInput("project", projectShortcode),
  previewDeleteInput("task", taskShortcode),
  previewDeleteInput("vendor", vendorShortcode),
  previewDeleteInput("purchase", purchaseShortcode),
  previewDeleteInput("expense", expenseShortcode),
  previewDeleteInput("inventory", inventoryShortcode),
  // Image has no shortcode and is the intentional hard-delete UUID exception.
  previewDeleteInput("image", z.uuid()),
  previewMergeInput("ingredient", ingredientShortcode),
  previewMergeInput("vendor", vendorShortcode),
  previewMergeInput("purchase", purchaseShortcode),
]);
export type PreviewOperationInput = z.infer<typeof previewOperationInputSchema>;

/** Per-candidate ranking data, returned by a merge preview with no `keepId`. */
export const mergeCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Ranked descending by the dialog to default the keeper. */
  weight: z.number().int().nonnegative(),
  detail: z.array(z.object({ label: z.string(), count: z.number().int() })),
});
export type MergeCandidate = z.infer<typeof mergeCandidateSchema>;

export const previewOperationSchema = z.object({
  operation: z.enum(["delete", "merge"]),
  entity: entitySchema,
  /** `soft` / `hard` for a delete; null for a merge. */
  mode: z.enum(["soft", "hard"]).nullable(),
  targetCount: z.number().int().nonnegative(),
  /**
   * False when a blocker will make the mutation throw. The dialog disables
   * confirmation on this — the ONLY thing a preview is allowed to gate, since
   * it is not a lock and the mutation rechecks everything in its transaction.
   */
  canProceed: z.boolean(),
  blockers: z.array(impactItemSchema),
  changes: z.array(impactItemSchema),
  sideEffects: z.array(impactItemSchema),
  /** Present only on a merge preview asked for without a `keepId`. */
  candidates: z.array(mergeCandidateSchema).optional(),
  generatedAt: z.iso.datetime(),
});
export type PreviewOperation = z.infer<typeof previewOperationSchema>;

/**
 * One live source row pointing at a soft-deleted target, on an edge whose
 * liveness rule is `must-target-live`.
 */
export const referentialLivenessViolationSchema = z.object({
  edgeKey: edgeKeySchema,
  role: edgeRoleSchema,
  /** The entity whose row was soft-deleted while still referenced. */
  targetEntity: entitySchema,
  targetId: z.uuid(),
  /** The pgTable holding the dangling reference. */
  sourceTable: z.string().min(1),
  sourceId: z.uuid(),
  description: z.string().min(1),
});
export type ReferentialLivenessViolation = z.infer<
  typeof referentialLivenessViolationSchema
>;
