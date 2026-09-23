/**
 * `INCOMING_EDGES` — the physical-fact half of `ENTITY_EDGES`
 * (`./entity-edges.ts`), projected down to what a SQL builder needs: the FK
 * `column` itself, plus `unconstrained`/`note`. `ENTITY_EDGES` is the single
 * source of truth; this is a real typed projection of it (not a second
 * hand-kept map), so it can never drift from `ENTITY_EDGE_SEMANTICS`
 * (`./entity-edge-semantics.ts`, the other projection) — both are built from
 * the same per-edge entries, so their key sets are identical by construction,
 * with no runtime parity check required.
 *
 * `IncomingEdgeKey<E>` stays a literal-key type (not widened to `string`):
 * every `IncomingEdgePolicy<E, ...>` an operation declares (there are 23 of
 * them) `satisfies`-checks its own keys against this, so a new edge is a
 * compile error at every operation until it has been given a disposition
 * there.
 */

import type { Entity } from "@cubby/schemas/entity";
import {
  type ShortcodeEntity,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import type { AnyColumn } from "drizzle-orm";

import type { EntityEdge } from "./entity-edges";
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
      },
    ]),
  ) as { [K in keyof T]: IncomingEdge };
}

export const INCOMING_EDGES = {
  cookbook: projectIncomingEdges(ENTITY_EDGES.cookbook),
  image: projectIncomingEdges(ENTITY_EDGES.image),
  recipe: projectIncomingEdges(ENTITY_EDGES.recipe),
  ingredient: projectIncomingEdges(ENTITY_EDGES.ingredient),
  meal: projectIncomingEdges(ENTITY_EDGES.meal),
  ledgerParty: projectIncomingEdges(ENTITY_EDGES.ledgerParty),
  product: projectIncomingEdges(ENTITY_EDGES.product),
  productCategory: projectIncomingEdges(ENTITY_EDGES.productCategory),
  location: projectIncomingEdges(ENTITY_EDGES.location),
  project: projectIncomingEdges(ENTITY_EDGES.project),
  task: projectIncomingEdges(ENTITY_EDGES.task),
  vendor: projectIncomingEdges(ENTITY_EDGES.vendor),
  vendorAccount: projectIncomingEdges(ENTITY_EDGES.vendorAccount),
  importRun: projectIncomingEdges(ENTITY_EDGES.importRun),
  purchase: projectIncomingEdges(ENTITY_EDGES.purchase),
  financialAccount: projectIncomingEdges(ENTITY_EDGES.financialAccount),
  financialTransaction: projectIncomingEdges(ENTITY_EDGES.financialTransaction),
  wish: projectIncomingEdges(ENTITY_EDGES.wish),
  expense: projectIncomingEdges(ENTITY_EDGES.expense),
  ledgerTransfer: projectIncomingEdges(ENTITY_EDGES.ledgerTransfer),
  plant: projectIncomingEdges(ENTITY_EDGES.plant),
  planting: projectIncomingEdges(ENTITY_EDGES.planting),
  gardenEntry: projectIncomingEdges(ENTITY_EDGES.gardenEntry),
  inventory: projectIncomingEdges(ENTITY_EDGES.inventory),
  "usda-food": projectIncomingEdges(ENTITY_EDGES["usda-food"]),
  device: projectIncomingEdges(ENTITY_EDGES.device),
  imageSighting: projectIncomingEdges(ENTITY_EDGES.imageSighting),
} satisfies Record<Entity, Record<string, IncomingEdge>>;

/** The declared incoming-edge keys for entity `E` — e.g. `IncomingEdgeKey<"image">`. */
export type IncomingEdgeKey<E extends Entity> =
  keyof (typeof INCOMING_EDGES)[E];

/**
 * A value for every incoming edge of `E` — the general form. Any map that must
 * stay exhaustive over an entity's edges uses this: stable per-edge semantics
 * (`ENTITY_EDGE_SEMANTICS`), an operation's dispositions
 * ({@link IncomingEdgePolicy}), or a per-edge SQL builder
 * (`PRODUCT_RETAINING_NOT_EXISTS`). Adding an edge above is a compile error in
 * every one of them until it's handled.
 */
export type IncomingEdgeMap<E extends Entity, Value> = Record<
  IncomingEdgeKey<E>,
  Value
>;

/**
 * An operation-specific decision for every incoming edge of `E`.
 *
 * Keep the disposition type local to the operation: deleting a purchase
 * detaches its expenses, while merging one re-points those same rows. This
 * alias supplies exhaustiveness without pretending the edge has one global
 * behavior.
 */
export type IncomingEdgePolicy<E extends Entity, Disposition> = IncomingEdgeMap<
  E,
  Disposition
>;

/**
 * Inverted view of {@link INCOMING_EDGES}: `<SourceTable>.<column>` → the
 * entity that FK column points at, restricted to targets that carry a public
 * shortcode (the only kind a raw id could usefully be re-rendered as). Derived
 * from INCOMING_EDGES rather than hand-kept a second time — a hand-kept
 * `(entityType, fieldName) -> target` table would be exactly the drift trap
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
