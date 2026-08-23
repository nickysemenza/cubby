import { z } from "zod";
import { entitySchema } from "./entity-core";
import {
  anyShortcodeSchema,
  cookbookShortcode,
  expenseShortcode,
  financialAccountShortcode,
  financialTransactionShortcode,
  imageShortcode,
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
  wishShortcode,
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
  /** A vendor purchase recorded against the target. */
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
  // `total` is deliberately NOT recomputed from the surviving keys: it is the
  // count across all selected targets, and under "drop" it stays honest about
  // the impact even when a key could not be named.
  return { ...item, byTargetId } as PublicImpactItem;
};

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
  "financialAccount",
  "financialTransaction",
  "inventory",
  "wish",
  "image",
]);
export type PreviewDeleteEntity = z.infer<typeof previewDeleteEntitySchema>;

/**
 * Entities that support merge. Hand-kept rather than derived from
 * `entityManifest[e].lifecycle.merge` — `entity-manifest.ts` itself imports
 * value-level schemas from THIS file (`entityLifecycleSchema`,
 * `entityRelationshipSchema`), so importing `entityManifest` back here would
 * be a circular value import: whichever of the two modules evaluates first
 * would read the other's not-yet-initialized export at module-load time. That
 * is not hypothetical — it was tried and threw
 * `TypeError: Cannot read properties of undefined (reading 'filter')` from
 * whichever module the test graph happened to reach second, breaking every
 * consumer of `@cubby/schemas`, not just this file's own tests.
 *
 * Kept honest by a drift test instead: see
 * `entity-manifest.unit.test.ts`, which asserts this list matches
 * `allEntities.filter((e) => entityManifest[e].lifecycle.merge)`.
 */
export const previewMergeEntitySchema = z.enum([
  "ingredient",
  "vendor",
  "purchase",
  "product",
]);
export type PreviewMergeEntity = z.infer<typeof previewMergeEntitySchema>;

/**
 * The id schema each entity's preview targets must satisfy — the per-entity
 * prefix check the `.superRefine` below applies once `entity` is known.
 */
const PREVIEW_TARGET_ID_SCHEMA = {
  product: productShortcode,
  recipe: recipeShortcode,
  ingredient: ingredientShortcode,
  cookbook: cookbookShortcode,
  meal: mealShortcode,
  location: locationShortcode,
  project: projectShortcode,
  task: taskShortcode,
  vendor: vendorShortcode,
  purchase: purchaseShortcode,
  expense: expenseShortcode,
  financialAccount: financialAccountShortcode,
  financialTransaction: financialTransactionShortcode,
  wish: wishShortcode,
  inventory: inventoryShortcode,
  image: imageShortcode,
} as const satisfies Record<PreviewDeleteEntity, z.ZodType<string, string>>;

/**
 * The field-level shape of one target id: any entity shortcode, `image`
 * included — it carries an `IMG-` code like every other local-table entity,
 * so no bare-uuid alternative belongs here. The entity isn't known until
 * `entity` is read, so the *exact* prefix is enforced in the refine below —
 * this alternation just keeps a real `pattern` in the advertised JSON Schema
 * instead of a bare string.
 */
const previewTargetId = anyShortcodeSchema([
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
  "financialAccount",
  "financialTransaction",
  "wish",
  "inventory",
  "image",
]);

const previewMergeEntities = new Set<string>(previewMergeEntitySchema.options);

/**
 * The parents of the three `<parent> ← product` relation families — the only
 * entities `attach`/`detach` can preview.
 *
 * ⚠️ Dispatch is on the PARENT'S SHORTCODE PREFIX, which is unambiguous only
 * because each of these has exactly one product-parented relation today
 * (`ProductComponent`, `ProjectToolUsage`, `PurchaseProduct`). A SECOND
 * product-parented relation — accessories, replacement parts, consumable-for —
 * would make `PRD-…` ambiguous. When that day comes, add an explicit
 * `relation` ENUM parameter here and in `attach_entity`; do NOT default it to
 * "components" and keep overloading the prefix, which silently reinterprets
 * every existing call.
 */
export const relationParentEntitySchema = z.enum([
  "product",
  "project",
  "purchase",
]);
export type RelationParentEntity = z.infer<typeof relationParentEntitySchema>;
const relationParentEntities = new Set<string>(
  relationParentEntitySchema.options,
);

/**
 * `preview_entity_operation`'s input — deliberately a FLAT object, not a union.
 *
 * This used to be a `z.union` of one object per `{operation, entity}` pair, and
 * that made the MCP tool **uncallable**: the SDK's `normalizeObjectSchema`
 * returns `undefined` for anything that isn't an object schema or a raw shape,
 * so the tool advertised `{type: "object", properties: {}}` and every argument
 * was stripped before the handler ran. A `z.discriminatedUnion` would not have
 * fixed it either — `z.toJSONSchema` still emits a top-level `anyOf`, and MCP
 * needs `type: "object"` with real `properties`.
 *
 * So the cross-field rules that the per-entity constructors used to get for
 * free — which fields belong to which operation, which entities support merge,
 * per-entity shortcode prefixes, `mergeIds` distinctness, `keepId` not being
 * one of the ids being merged away — all live in the refine below. Every
 * message names the offending value and says what was expected: an agent
 * calling this wrongly should learn what to send next, not just that it failed.
 */
/** `parentId`/`productIds` belong to attach/detach; say so rather than ignoring them. */
function rejectRelationFields(
  input: { parentId?: string; productIds?: string[] },
  ctx: z.core.$RefinementCtx,
  operation: "delete" | "merge",
) {
  for (const key of ["parentId", "productIds"] as const) {
    if (input[key] !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `\`${key}\` belongs to operation "attach"/"detach"; a ${operation} preview does not take it.`,
      });
    }
  }
}

export const previewOperationInputSchema = z
  .object({
    operation: z
      .enum(["delete", "merge", "attach", "detach"])
      .describe(
        "delete → pass `ids`. merge → pass `mergeIds` (and optionally `keepId`). attach/detach → pass `parentId` and `productIds`.",
      ),
    entity: previewDeleteEntitySchema.describe(
      `The entity the target ids name. Every entity here supports delete; only ${previewMergeEntitySchema.options.join(", ")} support merge.`,
    ),
    ids: z
      .array(previewTargetId)
      .min(1)
      .max(200)
      .optional()
      .describe(
        "delete only: the shortcodes to preview deleting (uuids for `image`). Must match the `entity` prefix — e.g. PRD- codes when entity is `product`.",
      ),
    mergeIds: z
      .array(previewTargetId)
      .min(1)
      .max(200)
      .optional()
      .describe(
        "merge only: the distinct shortcodes being merged together. Must match the `entity` prefix.",
      ),
    keepId: previewTargetId
      .optional()
      .describe(
        "merge only: the record to keep. Omit for candidate ranking; supply it for the final preview. Must not also appear in `mergeIds`.",
      ),
    parentId: anyShortcodeSchema(
      relationParentEntitySchema.options as unknown as [
        RelationParentEntity,
        ...RelationParentEntity[],
      ],
    )
      .optional()
      .describe(
        `attach/detach only: the row the edge hangs off — a ${relationParentEntitySchema.options.join(", ")} shortcode. Its prefix picks the relation, and must agree with \`entity\`.`,
      ),
    productIds: z
      .array(productShortcode)
      .min(1)
      .max(100)
      .optional()
      .describe(
        "attach/detach only: the PRD- codes on the other end of the edge. Always products — all three relation families are `<parent> ← product`.",
      ),
  })
  .superRefine((input, ctx) => {
    const idSchema = PREVIEW_TARGET_ID_SCHEMA[input.entity];
    const expected = `a ${input.entity} shortcode`;
    const checkId = (value: string, path: Array<string | number>) => {
      if (idSchema.safeParse(value).success) return;
      ctx.addIssue({
        code: "custom",
        path,
        message: `"${value}" is not ${expected}. Every id must match the \`entity\` you passed ("${input.entity}").`,
      });
    };
    const checkIds = (
      values: string[] | undefined,
      key: "ids" | "mergeIds",
    ) => {
      for (const [index, value] of (values ?? []).entries()) {
        checkId(value, [key, index]);
      }
    };

    if (input.operation === "attach" || input.operation === "detach") {
      if (!relationParentEntities.has(input.entity)) {
        ctx.addIssue({
          code: "custom",
          path: ["entity"],
          message: `${input.operation} is only supported for ${relationParentEntitySchema.options.join(", ")}; "${input.entity}" has no product relation.`,
        });
      }
      if (!input.parentId) {
        ctx.addIssue({
          code: "custom",
          path: ["parentId"],
          message: `operation "${input.operation}" requires \`parentId\` — the row the edge hangs off.`,
        });
      } else {
        checkId(input.parentId, ["parentId"]);
      }
      if (!input.productIds) {
        ctx.addIssue({
          code: "custom",
          path: ["productIds"],
          message: `operation "${input.operation}" requires \`productIds\` — the products on the other end of the edge.`,
        });
      }
      for (const key of ["ids", "mergeIds", "keepId"] as const) {
        if (input[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `\`${key}\` belongs to delete/merge; an ${input.operation} preview takes \`parentId\` plus \`productIds\`.`,
          });
        }
      }
      const productIds = input.productIds ?? [];
      if (new Set(productIds).size !== productIds.length) {
        ctx.addIssue({
          code: "custom",
          path: ["productIds"],
          message: "productIds must be distinct",
        });
      }
      return;
    }

    if (input.operation === "delete") {
      if (!input.ids) {
        ctx.addIssue({
          code: "custom",
          path: ["ids"],
          message:
            'operation "delete" requires `ids` — the ids of the rows to preview deleting.',
        });
      }
      for (const key of ["mergeIds", "keepId"] as const) {
        if (input[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `\`${key}\` belongs to operation "merge"; a delete preview takes \`ids\`.`,
          });
        }
      }
      rejectRelationFields(input, ctx, "delete");
      checkIds(input.ids, "ids");
      return;
    }

    if (!previewMergeEntities.has(input.entity)) {
      ctx.addIssue({
        code: "custom",
        path: ["entity"],
        message: `merge is only supported for ${previewMergeEntitySchema.options.join(", ")}; "${input.entity}" supports delete only.`,
      });
    }
    if (!input.mergeIds) {
      ctx.addIssue({
        code: "custom",
        path: ["mergeIds"],
        message:
          'operation "merge" requires `mergeIds` — the ids being merged together.',
      });
    }
    if (input.ids !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message:
          '`ids` belongs to operation "delete"; a merge preview takes `mergeIds` plus an optional `keepId`.',
      });
    }
    const mergeIds = input.mergeIds ?? [];
    if (new Set(mergeIds).size !== mergeIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["mergeIds"],
        message: "mergeIds must be distinct",
      });
    }
    rejectRelationFields(input, ctx, "merge");
    if (input.keepId !== undefined && mergeIds.includes(input.keepId)) {
      ctx.addIssue({
        code: "custom",
        path: ["keepId"],
        message: "keepId cannot also appear in mergeIds",
      });
    }
    checkIds(mergeIds, "mergeIds");
    if (input.keepId !== undefined) checkId(input.keepId, ["keepId"]);
  });

/** The flat, wire-shaped input — what the tool and the tRPC procedure accept. */
export type PreviewOperationInput = z.infer<typeof previewOperationInputSchema>;

/**
 * The same input narrowed to the per-operation shape the dispatcher matches on.
 * The flat schema is what MCP can advertise; this is what makes the router's
 * `match(...).exhaustive()` meaningful, and the refine above is what guarantees
 * the narrowing always succeeds for a parsed input.
 */
export type PreviewOperationRequest =
  | { operation: "delete"; entity: PreviewDeleteEntity; ids: string[] }
  | {
      operation: "merge";
      entity: PreviewMergeEntity;
      mergeIds: string[];
      /** Omit for candidate ranking; supply it for the final preview. */
      keepId?: string;
    }
  | {
      operation: "attach" | "detach";
      entity: RelationParentEntity;
      parentId: string;
      productIds: string[];
    };

/**
 * Narrow a parsed input for dispatch. Structural only — the schema owns
 * validation, so this throws just to keep the impossible cases out of the type.
 */
export function narrowPreviewOperationInput(
  input: PreviewOperationInput,
): PreviewOperationRequest {
  if (input.operation === "delete") {
    if (!input.ids) throw new Error("preview delete requires ids");
    return { operation: "delete", entity: input.entity, ids: input.ids };
  }
  if (input.operation === "attach" || input.operation === "detach") {
    if (!input.parentId || !input.productIds) {
      throw new Error(
        `preview ${input.operation} requires parentId and productIds`,
      );
    }
    const parentEntity = relationParentEntitySchema.safeParse(input.entity);
    if (!parentEntity.success) {
      throw new Error(
        `preview ${input.operation} does not support entity ${input.entity}`,
      );
    }
    return {
      operation: input.operation,
      entity: parentEntity.data,
      parentId: input.parentId,
      productIds: input.productIds,
    };
  }
  if (!input.mergeIds) throw new Error("preview merge requires mergeIds");
  const parsedEntity = previewMergeEntitySchema.safeParse(input.entity);
  if (!parsedEntity.success) {
    throw new Error(`preview merge does not support entity ${input.entity}`);
  }
  return {
    operation: "merge",
    entity: parsedEntity.data,
    mergeIds: input.mergeIds,
    ...(input.keepId === undefined ? {} : { keepId: input.keepId }),
  };
}

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
  operation: z.enum(["delete", "merge", "attach", "detach"]),
  entity: entitySchema,
  /** `soft` / `hard` for a delete; null for a merge, attach, or detach. */
  mode: z.enum(["soft", "hard"]).nullable(),
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
