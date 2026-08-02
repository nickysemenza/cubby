/**
 * The stable *meaning* of every incoming edge in `INCOMING_EDGES`
 * (`./entity-incoming-edges.ts`) — one `EdgeSemantics` record per edge,
 * covering all 14 entities and all 35 edges (three entities have none).
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
 * below.
 *
 * Key parity with `INCOMING_EDGES` — same 14 entity keys, same edge keys
 * within each, none missing, none extra — is enforced at compile time by the
 * `satisfies { [E in Entity]: IncomingEdgeMap<E, EdgeSemantics> }` clause
 * below: `IncomingEdgeMap` is `Record<IncomingEdgeKey<E>, Value>`, so adding,
 * removing, or renaming an edge in `INCOMING_EDGES` is a compile error here
 * until this map is updated to match.
 */

import type { Entity } from "@cubby/schemas/entity";
import type { EdgeSemantics } from "@cubby/schemas/entity-integrity";
import type { IncomingEdgeMap } from "./entity-incoming-edges";

export const ENTITY_EDGE_SEMANTICS = {
  cookbook: {
    "Recipe.cookbookId": {
      role: "owned-child",
      label: "recipes",
      description:
        "A recipe filed under this cookbook; deleting the cookbook takes its recipes with it.",
      liveness: { kind: "must-target-live" },
    },
  },
  image: {
    "Cookbook.coverImageId": {
      role: "media",
      label: "cookbook covers",
      description:
        "The cover photo for a cookbook, shown in cookbook lists and detail headers.",
      liveness: { kind: "must-target-live" },
    },
    "ProductImage.imageId": {
      role: "media",
      label: "product photos",
      description:
        "A photo or manual attachment linked to a product; says nothing about whether the product was ever owned.",
      liveness: { kind: "must-target-live" },
    },
    "LocationImage.imageId": {
      role: "media",
      label: "location photos",
      description:
        "A photo attached to a location — e.g. a picture of a shelf or bin.",
      liveness: { kind: "must-target-live" },
    },
    "RecipeImage.imageId": {
      role: "media",
      label: "recipe photos",
      description: "A photo attached to a recipe.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectImage.imageId": {
      role: "media",
      label: "project photos",
      description: "A photo attached to a household project.",
      liveness: { kind: "must-target-live" },
    },
    "PurchaseImage.imageId": {
      role: "media",
      label: "receipt attachments",
      description:
        "The emailed invoice PDF or a photo of the paper receipt attached to a purchase.",
      liveness: { kind: "must-target-live" },
    },
  },
  recipe: {
    "RecipeSection.recipeId": {
      role: "composition",
      label: "recipe sections",
      description:
        'A named section (e.g. "For the crust") that structures this recipe\'s ingredient list; meaningless outside the recipe it belongs to.',
      liveness: { kind: "must-target-live" },
    },
    "Ingredient.recipeId": {
      role: "reference",
      label: "sub-recipe ingredient lines",
      description:
        "An ingredient line in another recipe's section that uses this recipe as a sub-recipe (composition) rather than a plain ingredient.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Deleting a recipe deliberately preserves the recipe-as-ingredient pointer " +
          "(`preserve-sub-recipe-pointer` in RECIPE_DELETE_EDGE_POLICY, " +
          "apps/web/src/server/repo/recipe/crud.ts) so parent recipes still resolve " +
          "the tombstone for staleness detection and recompute, instead of silently " +
          "losing a line.",
      },
    },
    "MealRecipe.recipeId": {
      role: "association",
      label: "meal-plan entries",
      description:
        "A join row placing this recipe on the meal calendar; the meal and the recipe each exist independently of the pairing.",
      liveness: { kind: "must-target-live" },
    },
    "RecipeImage.recipeId": {
      role: "media",
      label: "recipe photos",
      description: "A photo attached to this recipe.",
      liveness: { kind: "must-target-live" },
    },
  },
  ingredient: {
    "RecipeSectionIngredient.ingredientId": {
      role: "usage",
      label: "recipe ingredient lines",
      description:
        "A line in a recipe section that calls for this ingredient with its own amount, unit, and note — a recipe reference, never an inventory decrement (nothing consumes stock as a side effect).",
      liveness: { kind: "must-target-live" },
    },
    "Product.ingredientId": {
      role: "reference",
      label: "products",
      description:
        "A purchasable product mapped to this ingredient — the one hop nutrition and costing resolve through (ingredient → product → fdc_id), never a direct link.",
      liveness: { kind: "must-target-live" },
    },
  },
  meal: {
    "MealRecipe.mealId": {
      role: "composition",
      label: "planned recipes",
      description:
        "A recipe assigned to this meal; the pairing is part of what the meal consists of, not an independent association.",
      liveness: { kind: "must-target-live" },
    },
  },
  product: {
    "ProductExternalId.productId": {
      role: "metadata",
      label: "external ids",
      description:
        "An external identifier (e.g. an ASIN) recorded against this product; says nothing about whether the product was ever owned.",
      liveness: { kind: "must-target-live" },
    },
    "ProductUnitMappings.productId": {
      role: "metadata",
      label: "unit mappings",
      description:
        "A hand-entered conversion (volume ↔ weight ↔ price) for this product; authored data, not evidence of purchase.",
      liveness: { kind: "must-target-live" },
    },
    "InventoryEntry.productId": {
      role: "acquisition",
      label: "inventory entries",
      description:
        "A shelf or bin count of this product currently on hand — proof it was actually acquired, not just cataloged.",
      liveness: { kind: "must-target-live" },
    },
    "ProductImage.productId": {
      role: "media",
      label: "product photos",
      description:
        "A photo or manual attachment for this product; says nothing about ownership.",
      liveness: { kind: "must-target-live" },
    },
    "Expense.productId": {
      role: "acquisition",
      label: "expenses",
      description:
        "A spend-ledger line recording money spent acquiring this product — the source of its net cost and owned/sold window; an orphaned product would silently corrupt that derivation with no restore path.",
      liveness: { kind: "must-target-live" },
    },
    "Task.subjectProductId": {
      role: "history",
      label: "tasks referencing them",
      description:
        "Durable work history performed on this product (e.g. a repair or maintenance task); deleting the subject would leave that history nameless.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectToolUsage.productId": {
      role: "history",
      label: "project uses",
      description:
        "Durable history that this reusable tool was used on a household project; deleting the tool would leave that history nameless.",
      liveness: { kind: "must-target-live" },
    },
  },
  location: {
    "InventoryEntry.locationId": {
      role: "contents",
      label: "inventory entries",
      description: "A product physically held at this location right now.",
      liveness: { kind: "must-target-live" },
    },
    "LocationImage.locationId": {
      role: "media",
      label: "location photos",
      description: "A photo attached to this location.",
      liveness: { kind: "must-target-live" },
    },
    "Location.parentId": {
      role: "hierarchy",
      label: "sub-locations",
      description:
        "A child location nested under this one in the house → room → shelf → bin tree; unconstrained at the DB level, walked via app code and relations() rather than an enforced FK.",
      liveness: { kind: "must-target-live" },
    },
  },
  project: {
    "Project.parentProjectId": {
      role: "hierarchy",
      label: "sub-projects",
      description:
        "A project nested under this one; sub-project dates and totals roll up into the parent's derived window.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectDependency.projectId": {
      role: "dependency",
      label: "blocked-by dependencies",
      description:
        "A dependency edge naming this project as the one blocked, waiting on another project to finish first.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectDependency.blockedByProjectId": {
      role: "dependency",
      label: "blocking dependencies",
      description:
        "A dependency edge naming this project as the blocker another project is waiting on.",
      liveness: { kind: "must-target-live" },
    },
    "Task.projectId": {
      role: "owned-child",
      label: "tasks",
      description:
        "A task filed under this project; deleting the project takes its tasks with it.",
      liveness: { kind: "must-target-live" },
    },
    "Expense.projectId": {
      role: "ledger",
      label: "expenses",
      description:
        "A spend-ledger line rolled up under this project — all money lives on Expense, so this is the source of the project's cost total.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectImage.projectId": {
      role: "media",
      label: "project photos",
      description: "A photo attached to this project.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectToolUsage.projectId": {
      role: "association",
      label: "used tools",
      description:
        "A durable association recording a reusable tool used on this exact project.",
      liveness: { kind: "must-target-live" },
    },
  },
  task: {
    "Task.parentTaskId": {
      role: "hierarchy",
      label: "sub-tasks",
      description: "A child task nested under this one.",
      liveness: { kind: "must-target-live" },
    },
    "TaskDependency.taskId": {
      role: "dependency",
      label: "blocked-by dependencies",
      description:
        "A dependency edge naming this task as the one blocked, waiting on another task to finish first.",
      liveness: { kind: "must-target-live" },
    },
    "TaskDependency.blockedByTaskId": {
      role: "dependency",
      label: "blocking dependencies",
      description:
        "A dependency edge naming this task as the blocker another task is waiting on.",
      liveness: { kind: "must-target-live" },
    },
  },
  vendor: {
    "Purchase.vendorId": {
      role: "transaction",
      label: "purchases",
      description:
        "A vendor order/receipt event recorded against this vendor (identified by orderId when one is issued), not the spend ledger or a card charge — the Vendor ──< Purchase ──< Expense chain.",
      liveness: { kind: "must-target-live" },
    },
  },
  purchase: {
    "Expense.purchaseId": {
      role: "ledger",
      label: "expenses",
      description:
        "A categorized line of spend booked against this purchase. All money lives on Expense.cost; the purchase's own statedTotal is a soft reconciliation cue and is never summed into spend.",
      liveness: { kind: "must-target-live" },
    },
    "PurchaseImage.purchaseId": {
      role: "media",
      label: "receipt attachments",
      description:
        "The invoice PDF or a photo of the paper receipt attached to this purchase.",
      liveness: { kind: "must-target-live" },
    },
    "FinancialTransaction.purchaseId": {
      role: "transaction",
      label: "financial transactions",
      description:
        "A settlement-side event linked to this vendor purchase. Its amount is evidence only; spend remains SUM(Expense.cost).",
      liveness: { kind: "must-target-live" },
    },
  },
  financialAccount: {
    "FinancialTransaction.accountId": {
      role: "transaction",
      label: "financial transactions",
      description:
        "A settlement-side event recorded by this financial account.",
      liveness: { kind: "must-target-live" },
    },
  },
  financialTransaction: {},
  expense: {},
  inventory: {},
  "usda-food": {},
} as const satisfies { [E in Entity]: IncomingEdgeMap<E, EdgeSemantics> };
