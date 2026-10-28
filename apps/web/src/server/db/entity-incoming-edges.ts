/** Physical projection of the compiled source references and explicit domain semantics.
 * Domain operation policies remain exhaustive over explicit edges; newly declared
 * ordinary references receive a conservative blocking disposition automatically.
 */

import type { Entity } from "@cubby/schemas/entity";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type ShortcodeEntity,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { type AnyColumn, eq, type SQL } from "drizzle-orm";

import { ENTITY_EDGE_OVERRIDES } from "./entity-edge-overrides";
import type { EdgeScope, EntityEdge } from "./entity-edges";
import { ENTITY_EDGES } from "./entity-edges";

export interface IncomingEdge {
  /** The FK column, on the referencing table, that points at this entity's `id`. */
  column: AnyColumn;
  /**
   * True when the relationship is real (modeled in `relations()`, walked by
   * app code) but carries no DB-level FK constraint. Predicates that need to
   * walk the relationship still can; they just can't rely on the database to
   * enforce or cascade it.
   */
  unconstrained?: true;
  /** Free-text justification, for an edge whose key alone doesn't explain itself. */
  note?: string;
  /** Restricts `column`'s table to this edge's rows; see `EntityEdge.scope`. */
  scope?: EdgeScope;
}

/** Drop an `EntityEdge`'s stable-semantics fields, keeping only the physical facts. */
function projectIncomingEdges<T extends Record<string, EntityEdge>>(
  edgeMap: T,
): { [K in keyof T]: IncomingEdge } {
  // SAFETY: same keys as `edgeMap`, each value the physical subset of that
  // key's edge — `fromEntries` erases the keys the mapped type restores.
  return Object.fromEntries(
    Object.entries(edgeMap).map(([key, edge]) => [
      key,
      {
        column: edge.column,
        unconstrained: edge.unconstrained,
        note: edge.note,
        scope: edge.scope,
      },
    ]),
  ) as { [K in keyof T]: IncomingEdge };
}

// SAFETY: entries retain every entity and edge key; the mapped type restores
// the keys erased by Object.fromEntries without a second entity roster.
const INCOMING_EDGES = Object.fromEntries(
  Object.entries(ENTITY_EDGES).map(([entity, edgeMap]) => [
    entity,
    projectIncomingEdges(edgeMap),
  ]),
) as {
  [E in keyof typeof ENTITY_EDGES]: {
    [K in keyof (typeof ENTITY_EDGES)[E]]: IncomingEdge;
  };
};

/** The declared incoming-edge keys for entity `E` — e.g. `IncomingEdgeKey<"image">`. */
export type IncomingEdgeKey<E extends Entity> =
  keyof (typeof INCOMING_EDGES)[E];

/** Domain edges remain exhaustive; ordinary source references default to refusal. */
export type IncomingEdgePolicy<E extends Entity, Disposition> = Record<
  keyof (typeof ENTITY_EDGE_OVERRIDES)[E],
  Disposition
> &
  Partial<Record<IncomingEdgeKey<E>, Disposition>>;

export const ORDINARY_REFERENCE_BLOCK: OperationDisposition = {
  code: "block-ordinary-reference",
  effect: "block",
  description:
    "An ordinary reference requires an explicit operation policy before its target can be removed or merged.",
};

export const ordinaryIncomingEdgeKeys = (entity: Entity): string[] =>
  Object.keys(INCOMING_EDGES[entity]).filter(
    (key) => !(key in ENTITY_EDGE_OVERRIDES[entity]),
  );

/** The same conservative policy feeds execution and the integrity catalog. */
export const effectiveIncomingEdgePolicy = (
  entity: Entity,
  policy: Readonly<Record<string, OperationDisposition>>,
) => ({
  ...Object.fromEntries(
    ordinaryIncomingEdgeKeys(entity).map((key) => [
      key,
      ORDINARY_REFERENCE_BLOCK,
    ]),
  ),
  ...policy,
});

/**
 * Inverted view of {@link INCOMING_EDGES}: `<SourceTable>.<column>` → the
 * entity that FK column points at, restricted to targets that carry a public
 * shortcode (the only kind a raw id could usefully be re-rendered as). Derived
 * from INCOMING_EDGES rather than hand-kept a second time — a hand-kept
 * `(entityKind, fieldName) -> target` table would be exactly the drift trap
 * this file exists to prevent (see the module doc comment above).
 *
 * Built for `getAuditLog` (repo/audit-log.ts): a `changes` diff records the raw
 * FK column value for fields like `vendorId`/`purchaseId`/`projectId`, and this
 * map is how the audit-log reader knows which of those values name another
 * entity worth resolving to its shortcode, without a second source of truth
 * for "which fields are FKs".
 */
export const EDGE_KEY_TARGET_ENTITY: ReadonlyMap<string, ShortcodeEntity> =
  new Map(
    shortcodeEntities.flatMap((targetEntity) =>
      Object.keys(INCOMING_EDGES[targetEntity]).map(
        (edgeKey) => [edgeKey, targetEntity] as const,
      ),
    ),
  );

/** An edge's `scope` restriction as a WHERE term, when it has one. */
export const edgeScopeWhere = (edge: { scope?: EdgeScope }): SQL | undefined =>
  edge.scope ? eq(edge.scope.column, edge.scope.value) : undefined;

export { INCOMING_EDGES };
