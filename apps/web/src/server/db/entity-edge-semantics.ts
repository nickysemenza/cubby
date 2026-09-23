/**
 * `ENTITY_EDGE_SEMANTICS` — the stable-meaning half of `ENTITY_EDGES`
 * (`./entity-edges.ts`), projected down to `role` / `label` / `description` /
 * `liveness`, with the Drizzle `column` dropped. This is what gets published
 * as catalog data over the wire (`entity-integrity.service.ts`), so it must
 * never carry an un-serializable Drizzle column object — the projection
 * builds a fresh plain object per edge rather than aliasing `ENTITY_EDGES`'s
 * entry.
 *
 * `ENTITY_EDGES` is the single source of truth; `INCOMING_EDGES`
 * (`./entity-incoming-edges.ts`, the other projection) is built from the same
 * per-edge entries, so the two can never drift out of key parity — no
 * separate `satisfies` clause or runtime check is needed to keep them in
 * sync, unlike when they were two independently hand-kept maps.
 *
 * Each projection call below is generic over its own entity's edge map
 * (`ENTITY_EDGES.product`, etc.), not a single loop over every entity, so
 * that TypeScript infers `{ [K in keyof T]: Pick<T[K], ...> }` per call and
 * keeps each edge's own literal `role` (e.g. `"acquisition"`) rather than
 * widening it to the general `EdgeRole` union. That literal-narrowness is
 * load-bearing: `ProductRetainingEdgeKey`
 * (`repo/product/edge-roles.ts`) selects keys by testing
 * `PRODUCT_EDGE_ROLES[K]["role"] extends RetainingRole`, which only picks out
 * the right subset when `role` is still each edge's own literal type — if it
 * were widened to `EdgeRole`, every key's `role` would be the full union,
 * that `extends` check would fail for all of them, and the retaining set
 * would silently become empty.
 *
 * "Stable" is the whole point: a `role` describes what the edge represents in
 * the domain (a photo, a ledger line, a hierarchy pointer) — never what any
 * particular operation does about it. `Expense.purchaseId` is a `ledger` edge
 * whether a purchase delete clears it or a purchase merge re-points it; the
 * role doesn't change because the operation does. What an operation actually
 * does — block, detach, hard-delete, repoint, and so on — is an
 * `OperationDisposition`, decided per call site (see `PRODUCT_EDGE_ROLES` in
 * `repo/product/edge-roles.ts` and `RECIPE_DELETE_EDGE_POLICY` in
 * `repo/recipe/crud.ts` for two operations that disposition the same kind of
 * edge differently). Nothing here encodes delete/merge/detach behavior, and
 * nothing here should ever need to change when an operation's policy changes.
 *
 * `liveness` is the one place this file *does* make a normative claim: for
 * almost every edge, a live source row pointing at a soft-deleted target is a
 * bug (`must-target-live`, the referential-liveness audit's invariant). The
 * lone exception is `recipe`'s `"Ingredient.recipeId"` — see its own comment
 * in `entity-edges.ts`.
 */

import type { Entity } from "@cubby/schemas/entity";
import type { EdgeSemantics } from "@cubby/schemas/entity-integrity";

import type { EntityEdge } from "./entity-edges";
import { ENTITY_EDGES } from "./entity-edges";
import type { IncomingEdgeMap } from "./entity-incoming-edges";

/** Project one entity's edge map down to its stable-semantics fields only. */
function projectSemantics<T extends Record<string, EntityEdge>>(
  edgeMap: T,
): {
  [K in keyof T]: Pick<T[K], "role" | "label" | "description" | "liveness">;
} {
  // SAFETY: same keys as `edgeMap`, each value a subset of that key's edge —
  // `fromEntries` erases the per-key literal types the mapped type restores.
  return Object.fromEntries(
    Object.entries(edgeMap).map(([key, edge]) => [
      key,
      {
        role: edge.role,
        label: edge.label,
        description: edge.description,
        liveness: edge.liveness,
      },
    ]),
  ) as {
    [K in keyof T]: Pick<T[K], "role" | "label" | "description" | "liveness">;
  };
}

export const ENTITY_EDGE_SEMANTICS = {
  cookbook: projectSemantics(ENTITY_EDGES.cookbook),
  image: projectSemantics(ENTITY_EDGES.image),
  recipe: projectSemantics(ENTITY_EDGES.recipe),
  ingredient: projectSemantics(ENTITY_EDGES.ingredient),
  meal: projectSemantics(ENTITY_EDGES.meal),
  ledgerParty: projectSemantics(ENTITY_EDGES.ledgerParty),
  product: projectSemantics(ENTITY_EDGES.product),
  productCategory: projectSemantics(ENTITY_EDGES.productCategory),
  location: projectSemantics(ENTITY_EDGES.location),
  project: projectSemantics(ENTITY_EDGES.project),
  task: projectSemantics(ENTITY_EDGES.task),
  vendor: projectSemantics(ENTITY_EDGES.vendor),
  vendorAccount: projectSemantics(ENTITY_EDGES.vendorAccount),
  importRun: projectSemantics(ENTITY_EDGES.importRun),
  purchase: projectSemantics(ENTITY_EDGES.purchase),
  financialAccount: projectSemantics(ENTITY_EDGES.financialAccount),
  financialTransaction: projectSemantics(ENTITY_EDGES.financialTransaction),
  wish: projectSemantics(ENTITY_EDGES.wish),
  expense: projectSemantics(ENTITY_EDGES.expense),
  ledgerTransfer: projectSemantics(ENTITY_EDGES.ledgerTransfer),
  plant: projectSemantics(ENTITY_EDGES.plant),
  planting: projectSemantics(ENTITY_EDGES.planting),
  gardenEntry: projectSemantics(ENTITY_EDGES.gardenEntry),
  inventory: projectSemantics(ENTITY_EDGES.inventory),
  "usda-food": projectSemantics(ENTITY_EDGES["usda-food"]),
  device: projectSemantics(ENTITY_EDGES.device),
  imageSighting: projectSemantics(ENTITY_EDGES.imageSighting),
} satisfies { [E in Entity]: IncomingEdgeMap<E, EdgeSemantics> };
