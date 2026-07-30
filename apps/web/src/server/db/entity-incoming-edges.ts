/**
 * Pure fact table of incoming foreign-key edges per entity — for every entity
 * `E`, every column (on some other table, usually a join table) that carries a
 * live reference to `E.id`.
 *
 * Lives in `server/db`, not `packages/schemas`: the values are `AnyColumn`
 * references into `schema.ts`, and schemas cannot import `drizzle-orm/pg-core`
 * (see the CLAUDE.md layering note on the WASM/schemas boundary — this is the
 * same shape of rule, one level down).
 *
 * **The map holds edges only — no disposition.** What a caller should DO with
 * an edge (hard-delete the row, null the FK, refuse the parent delete, ignore
 * it entirely) is not a property of the edge itself: `image`'s six edges
 * disposition differently under a hard delete (`deleteRow`/`clearFk` — see
 * `IMAGE_HARD_DELETE` in repo/image.ts) than they would under some other
 * operation, and `product`'s five edges split into "acquisition" vs "metadata"
 * roles differently again depending on which predicate is asking. A per-edge
 * global disposition would be wrong on the facts, not merely weak. Each
 * predicate that cares owns its own `Record<IncomingEdgeKey<E>, ...>` keyed off
 * this map, so a new edge here is a compile error at every predicate until it's
 * been given a disposition there.
 *
 * Cross-checked against schema.ts by entity-manifest-fk.unit.test.ts, which
 * introspects every `pgTable` in schema.ts and asserts:
 *   1. every real FK it finds pointing at an entity's table is declared here
 *      (the assertion that would have caught `PurchaseImage.imageId` missing
 *      from `image`'s edges — the bug this file exists to prevent recurring);
 *   2. every edge declared here that introspection does NOT find is marked
 *      `unconstrained` (catches typos/renames — Location.parentId is the one
 *      legitimate case, a logical self-reference with no DB-level FK); and
 *   3. every FK target that is neither an entity nor in the test's
 *      `NON_ENTITY_FK_TARGETS` allowlist fails, forcing a one-line
 *      justification for stepping outside the entity graph.
 */

import type { Entity } from "@cubby/schemas/entity";
import type { AnyColumn } from "drizzle-orm";
import {
  cookbook,
  expense,
  ingredient,
  inventoryEntry,
  location,
  locationImage,
  mealRecipe,
  product,
  productExternalId,
  productImage,
  productUnitMappings,
  project,
  projectDependency,
  projectImage,
  purchase,
  purchaseImage,
  recipe,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
  task,
  taskDependency,
} from "./schema";

/** `${pgTable name}.${column name}` — e.g. `"PurchaseImage.imageId"`. */
type EdgeKey<C extends AnyColumn> = `${C["_"]["tableName"]}.${C["_"]["name"]}`;

export interface IncomingEdge {
  /** The FK column, on the referencing table, that points at this entity's `id`. */
  column: AnyColumn;
  /**
   * True when the relationship is real (modeled in `relations()`, walked by
   * app code) but carries no DB-level FK constraint — `Location.parentId` is
   * the one case today (see its column definition in schema.ts: no
   * `.references()`). Predicates that need to walk the relationship still can;
   * they just can't rely on the database to enforce or cascade it.
   */
  unconstrained?: true;
  /** Free-text justification, for an edge whose key alone doesn't explain itself. */
  note?: string;
}

/**
 * Forces every entry's key to equal `EdgeKey<its own column>`. Drizzle
 * preserves a concretely-declared column's table name and column name as
 * literal string types (see `productImage.imageId`'s inferred type), so
 * key↔column correspondence is checkable even though completeness of the edge
 * SET is not — a mis-keyed entry (wrong table, wrong column, a typo) fails to
 * satisfy this and is a compile error at the `edges({...})` call site. Set
 * completeness is entity-manifest-fk.unit.test.ts's job, not this type's.
 */
type WellKeyed<T extends Record<string, IncomingEdge>> = {
  [K in keyof T]: K extends EdgeKey<T[K]["column"]> ? unknown : never;
};

function edges<T extends Record<string, IncomingEdge>>(t: T & WellKeyed<T>): T {
  return t;
}

export const INCOMING_EDGES = {
  cookbook: edges({
    "Recipe.cookbookId": { column: recipe.cookbookId },
  }),
  image: edges({
    "Cookbook.coverImageId": { column: cookbook.coverImageId },
    "ProductImage.imageId": { column: productImage.imageId },
    "LocationImage.imageId": { column: locationImage.imageId },
    "RecipeImage.imageId": { column: recipeImage.imageId },
    "ProjectImage.imageId": { column: projectImage.imageId },
    "PurchaseImage.imageId": { column: purchaseImage.imageId },
  }),
  recipe: edges({
    "RecipeSection.recipeId": { column: recipeSection.recipeId },
    "Ingredient.recipeId": { column: ingredient.recipeId },
    "MealRecipe.recipeId": { column: mealRecipe.recipeId },
    "RecipeImage.recipeId": { column: recipeImage.recipeId },
  }),
  ingredient: edges({
    "RecipeSectionIngredient.ingredientId": {
      column: recipeSectionIngredient.ingredientId,
    },
    "Product.ingredientId": { column: product.ingredientId },
  }),
  meal: edges({
    "MealRecipe.mealId": { column: mealRecipe.mealId },
  }),
  product: edges({
    "ProductExternalId.productId": { column: productExternalId.productId },
    "ProductUnitMappings.productId": {
      column: productUnitMappings.productId,
    },
    "InventoryEntry.productId": { column: inventoryEntry.productId },
    "ProductImage.productId": { column: productImage.productId },
    "Expense.productId": { column: expense.productId },
  }),
  location: edges({
    "InventoryEntry.locationId": { column: inventoryEntry.locationId },
    "LocationImage.locationId": { column: locationImage.locationId },
    // Sub-locations. No `.references()` on `location.parentId` in schema.ts —
    // deliberately unconstrained (see the column's own comment there); the
    // logical parent/child tree is walked via app code and `relations()`, not
    // a DB-enforced FK.
    "Location.parentId": {
      column: location.parentId,
      unconstrained: true,
    },
  }),
  project: edges({
    "Project.parentProjectId": { column: project.parentProjectId },
    "ProjectDependency.projectId": { column: projectDependency.projectId },
    "ProjectDependency.blockedByProjectId": {
      column: projectDependency.blockedByProjectId,
    },
    "Task.projectId": { column: task.projectId },
    "Expense.projectId": { column: expense.projectId },
    "ProjectImage.projectId": { column: projectImage.projectId },
  }),
  task: edges({
    "Task.parentTaskId": { column: task.parentTaskId },
    "TaskDependency.taskId": { column: taskDependency.taskId },
    "TaskDependency.blockedByTaskId": {
      column: taskDependency.blockedByTaskId,
    },
  }),
  vendor: edges({
    "Purchase.vendorId": { column: purchase.vendorId },
  }),
  purchase: edges({
    "Expense.purchaseId": { column: expense.purchaseId },
    "PurchaseImage.purchaseId": { column: purchaseImage.purchaseId },
  }),
  // No table carries a live FK at these three: `expense`/`inventory` are leaf
  // ledger/stock rows nothing else points back at, and `usda-food` has no
  // local table at all (it's resolved at query time via `product.fdc_id`, a
  // cross-system id link rather than a DB FK — see usda-link-resolved-at-
  // query-time).
  expense: edges({}),
  inventory: edges({}),
  "usda-food": edges({}),
} as const satisfies Record<Entity, Record<string, IncomingEdge>>;

/** The declared incoming-edge keys for entity `E` — e.g. `IncomingEdgeKey<"image">`. */
export type IncomingEdgeKey<E extends Entity> =
  keyof (typeof INCOMING_EDGES)[E];
