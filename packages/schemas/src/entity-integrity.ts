import { z } from "zod";
import { entitySchema } from "./entity-core";

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

export const edgeKeySchema = z
  .string()
  .regex(
    /^[A-Z][A-Za-z0-9_]*\.[a-z][A-Za-z0-9_]*$/,
    "expected `Table.column`, e.g. `PurchaseImage.imageId`",
  )
  // The test fixture generator can't synthesize a string matching a regex, so
  // hand it one real edge key. See `mockValueHint` in lib/test/mock-schema.ts.
  .meta({ mockValue: "EntityAttachment.imageId" });
export type EdgeKey = z.infer<typeof edgeKeySchema>;

/**
 * What an incoming edge *means*, independent of what any one operation does
 * about it. Stable: a role never encodes delete/merge behavior (that's an
 * `OperationDisposition`), so the same edge can block one operation and be
 * re-pointed by another without its role changing.
 */
export const edgeRoleSchema = z.enum([
  "owned-child",
  "association",
  "composition",
  "metadata",
  "acquisition",
  "history",
  "hierarchy",
  "dependency",
  "contents",
  "media",
  "ledger",
  "transaction",
  "reference",
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
  label: z.string().min(1),
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
 * - `unconstrained` — a real relationship the app walks with no DB-level FK
 *   to verify. Names the edge, which must itself be marked `unconstrained` in
 *   `INCOMING_EDGES`.
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
    sourceColumns: z.array(edgeKeySchema).min(1),
  }),
]);
export type RelationshipProvenance = z.infer<
  typeof relationshipProvenanceSchema
>;

const relationshipSourceSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  provenance: relationshipProvenanceSchema,
  inverse: z
    .object({ steps: z.array(relationshipPathStepSchema).min(1) })
    .optional(),
});

const sourceRefSchema = z.object({
  module: z.string().min(1),
  export: z.string().min(1),
});

const relationshipMutationSchema = z.object({
  source: z.string().min(1),
  itemSchema: sourceRefSchema,
  rowSchema: sourceRefSchema,
  adapter: sourceRefSchema,
  audiences: z.array(z.enum(["browser", "mcp"])).min(1),
});

export const entityRelationshipSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  target: entitySchema,
  cardinality: z.enum(["one", "many"]),
  sourceKey: z.string().min(1).optional(),
  provenance: relationshipProvenanceSchema,
  inverse: z
    .object({ steps: z.array(relationshipPathStepSchema).min(1) })
    .optional(),
  sources: z.array(relationshipSourceSchema).default([]),
  mutation: relationshipMutationSchema.optional(),
  /** The compiler derived this `many` inverse from another entity's FK. */
  derived: z.literal(true).optional(),
  /** Why this single-FK `one` relation's target gets no derived inverse. */
  inverseOmit: z.string().min(1).optional(),
});
export type EntityRelationship = z.infer<typeof entityRelationshipSchema>;

export const entityLifecycleSchema = z.object({
  delete: z
    .object({
      mode: z.enum(["soft", "hard"]),
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
  targetEntity: entitySchema,
  sourceTable: z.string().min(1),
  sourceColumn: z.string().min(1),
  /** False when the relationship is real but carries no DB-level FK constraint. */
  constrained: z.boolean(),
  semantics: edgeSemanticsSchema,
});
export type PhysicalEdge = z.infer<typeof physicalEdgeSchema>;

export const lifecycleOperationSchema = z.object({
  entity: entitySchema,
  operation: z.enum(["delete", "merge"]),
  owner: z.enum(["kernel", "workflow"]),
  dispositions: z.array(
    z.object({
      edgeKey: edgeKeySchema,
      disposition: operationDispositionSchema,
    }),
  ),
});
export type LifecycleOperation = z.infer<typeof lifecycleOperationSchema>;

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
  coverage: z.object({
    relationships: z.number().int(),
    incomingEdges: z.number().int(),
    auditedEdges: z.number().int(),
    exemptEdges: z.number().int(),
    operations: z.number().int(),
  }),
});
export type IntegrityCatalog = z.infer<typeof integrityCatalogSchema>;

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

/**
 * The same shape in two id spaces, kept apart by the type system.
 *
 * `byTargetId` is keyed by whatever id the producer had. Inside a planner that
 * is the RAW DATABASE UUID; on the wire it must be the public shortcode, because
 * a uuid may never cross the API boundary. One structural type served both, so
 * nothing stopped an internally-built item from being returned directly — the
 * hazard is invisible at a call site since both are `Record<string, number>`.
 *
 * The brands make them mutually unassignable, and {@link toPublicImpact} is the
 * only way to obtain a `PublicImpactItem`. So the translation cannot be
 * forgotten; it can only be performed.
 *
 * Both brands are type-level only — the runtime value is unchanged, and an
 * existing `ImpactItem` still satisfies the underlying shape.
 */
export const internalImpactItemSchema =
  impactItemSchema.brand("InternalImpactItem");
export type InternalImpactItem = z.infer<typeof internalImpactItemSchema>;

export const publicImpactItemSchema =
  impactItemSchema.brand("PublicImpactItem");
export type PublicImpactItem = z.infer<typeof publicImpactItemSchema>;

/**
 * What to do with a target id that has no public id.
 *
 * A preview is advisory, so dropping an unmappable key merely understates the
 * impact — that was the pre-existing behavior and it stays available, now named
 * rather than implicit. A mutation RESULT is a different matter: silently
 * dropping a blocked id would report fewer blockers than actually blocked, so
 * those callers pass `"throw"` and find out.
 */
export type UnmappedTargetPolicy = "drop" | "throw";

export const toPublicImpact = (
  item: ImpactItem,
  publicIdByEntityId: ReadonlyMap<string, string>,
  onUnmapped: UnmappedTargetPolicy,
): PublicImpactItem => {
  const byTargetId: Record<string, number> = {};
  for (const [entityId, count] of Object.entries(item.byTargetId)) {
    const publicId = publicIdByEntityId.get(entityId);
    if (publicId === undefined) {
      if (onUnmapped === "throw") {
        throw new Error(
          `toPublicImpact(${item.code}): no public id for target ${entityId}`,
        );
      }
      continue;
    }
    byTargetId[publicId] = count;
  }
  return publicImpactItemSchema.parse({ ...item, byTargetId });
};

export const previewOperationSchema = z.object({
  operation: z.enum(["attach", "detach"]),
  entity: entitySchema,
  relation: z.string().min(1),
  targetCount: z.number().int().nonnegative(),
  /**
   * False when a blocker will make the mutation throw. The dialog disables
   * confirmation on this — the ONLY thing a preview is allowed to gate, since
   * it is not a lock and the mutation rechecks everything in its transaction.
   */
  canProceed: z.boolean(),
  // Branded: this is a wire shape, so every item must have come through
  // `toPublicImpact` and be keyed by shortcode rather than raw uuid.
  blockers: z.array(publicImpactItemSchema),
  changes: z.array(publicImpactItemSchema),
  sideEffects: z.array(publicImpactItemSchema),
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
  sourceTable: z.string().min(1),
  sourceId: z.uuid(),
  description: z.string().min(1),
});
export type ReferentialLivenessViolation = z.infer<
  typeof referentialLivenessViolationSchema
>;
