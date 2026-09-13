/**
 * The stable *meaning* of every incoming edge in `INCOMING_EDGES`
 * (`./entity-incoming-edges.ts`) — one `EdgeSemantics` record per edge,
 * covering all 14 entities and all 36 edges (two entities have none).
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
    "Vendor.logoImageId": {
      role: "media",
      label: "vendor logos",
      description:
        "An optional brand mark for a vendor; absence deliberately falls back to the vendor monogram.",
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
    "GardenEntryImage.imageId": {
      role: "media",
      label: "garden entry photos",
      description: "A full-scene photo attached to a dated garden entry.",
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
    "Product.growsIngredientId": {
      role: "reference",
      label: "garden source products",
      description:
        "A seed packet, seedling, or plant product can name the ingredient it grows without becoming edible inventory.",
      liveness: { kind: "must-target-live" },
    },
    "Planting.ingredientId": {
      role: "history",
      label: "plantings",
      description: "A garden planting retains the crop ingredient it records.",
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
    "MealRecipePortion.mealId": {
      role: "association",
      label: "served portions",
      description:
        "A gram portion from a recipe preparation assigned for consumption at this meal, including portions from an earlier leftovers source.",
      liveness: { kind: "must-target-live" },
    },
  },
  ledgerParty: {
    "ExpenseAttribution.ledgerPartyId": {
      role: "ledger",
      label: "beneficiary attributions",
      description:
        "A weighted expense beneficiary or funder share; money remains on the expense itself.",
      liveness: { kind: "must-target-live" },
    },
    "FinancialAccount.ledgerPartyId": {
      role: "reference",
      label: "financial accounts",
      description:
        "The member or household party an evidence account belongs to.",
      liveness: { kind: "must-target-live" },
    },
    "LedgerTransfer.fromPartyId": {
      role: "ledger",
      label: "outgoing transfers",
      description: "A transfer source endpoint.",
      liveness: { kind: "must-target-live" },
    },
    "LedgerTransfer.toPartyId": {
      role: "ledger",
      label: "incoming transfers",
      description: "A transfer target endpoint.",
      liveness: { kind: "must-target-live" },
    },
    "MealRecipePortion.ledgerPartyId": {
      role: "association",
      label: "meal portions",
      description:
        "A planned or confirmed gram portion naming this member or guest as its eater.",
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
        "Durable history that this reusable tool or software Product was used on a household project; deleting the Product would leave that history nameless.",
      liveness: { kind: "must-target-live" },
    },
    "PurchaseProduct.productId": {
      role: "acquisition",
      label: "purchase links",
      description:
        "The vendor order this Product was bought on. Provenance, not money — it exists because an order paid in installments is an `allocation` whose Expenses can never carry a productId, leaving the goods with no path back to the order.",
      liveness: { kind: "must-target-live" },
    },
    "WishCandidate.productId": {
      role: "association",
      label: "wishlist candidates",
      description:
        "A tool Product considered as an alternative for a household Wishlist entry; it is planning data, not inventory or spend.",
      liveness: { kind: "must-target-live" },
    },
    "Location.productId": {
      role: "reference",
      label: "locations",
      description:
        "A Location that IS an instance of this Product — the bin, tote or rack itself, not stock held in it. Deleting the Product would leave those locations with neither a type nor an identity, since a linked location stops carrying its own `type`.",
      liveness: { kind: "must-target-live" },
    },
    "Cookbook.productId": {
      role: "reference",
      label: "cookbooks",
      description:
        "A Cookbook whose physical copy this Product is — the book on the shelf behind the imported EPUB. Deleting the Product leaves the cookbook and its recipes intact; only the shelf link goes.",
      liveness: { kind: "must-target-live" },
    },
    "ProductComponent.parentProductId": {
      role: "composition",
      label: "kit components",
      description:
        "A row on this Product's own component list — what's inside it, when it's a kit or multi-pack. Deleting the kit takes its component list with it.",
      liveness: { kind: "must-target-live" },
    },
    "ProductComponent.componentProductId": {
      role: "usage",
      label: "kits it's listed inside",
      description:
        "This Product cited as a part of another (kit) Product's component list, with its own quantity. The kit and the part remain independently real products; this only says the part is currently accounted for inside the kit.",
      liveness: { kind: "must-target-live" },
    },
    "ProductConversionCoverage.productId": {
      role: "metadata",
      label: "conversion coverage projections",
      description:
        "A rebuildable conversion-graph projection owned by this product.",
      liveness: { kind: "must-target-live" },
    },
    "Planting.sourceProductId": {
      role: "history",
      label: "source products",
      description:
        "A planting can retain the seed packet, seedling, or plant it came from.",
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
        "A child location nested under this one in the house → room → shelf → bin tree, enforced by the Location parent self-FK.",
      liveness: { kind: "must-target-live" },
    },
    "Planting.locationId": {
      role: "contents",
      label: "current plantings",
      description: "A growing planting is currently in this garden location.",
      liveness: { kind: "must-target-live" },
    },
    "Planting.intendedLocationId": {
      role: "reference",
      label: "planned plantings",
      description:
        "A planned planting can name the bed or tray it is intended for.",
      liveness: { kind: "must-target-live" },
    },
    "GardenEntry.locationId": {
      role: "history",
      label: "garden entries",
      description:
        "A garden entry retains the location where the observation happened.",
      liveness: { kind: "must-target-live" },
    },
    "PlantingLocationPeriod.locationId": {
      role: "history",
      label: "planting location history",
      description: "A confirmed interval retains the location it records.",
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
      label: "reusable resources",
      description:
        "A durable association recording a reusable tool or software Product used on this exact project.",
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
    "PurchaseProduct.purchaseId": {
      role: "association",
      label: "products",
      description:
        "A Product this order bought. Carries no money — spend stays entirely on Expense — so this never doubles as a second ledger path.",
      liveness: { kind: "must-target-live" },
    },
    "FinancialTransactionAllocation.purchaseId": {
      role: "transaction",
      label: "settlement allocations",
      description:
        "A slice of one card or bank transaction attributed to this purchase. One real charge can settle several purchases, so the slice — not the whole transaction — is what this order settled. The amount is evidence only; spend remains SUM(Expense.cost).",
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
    "StatementRow.accountId": {
      role: "reference",
      label: "statement rows",
      description:
        "A provider statement line an agent judged to belong to this account. Evidence Cubby is reconciled against, not a settlement event: the row is what the export said, and assigning it an account is a human judgment rather than something the import derived.",
      liveness: { kind: "must-target-live" },
    },
  },
  financialTransaction: {
    "FinancialTransactionAllocation.transactionId": {
      role: "composition",
      label: "purchase allocations",
      description:
        "One slice of this transaction's amount, attributed to a single Purchase. The slices are meaningless apart from the charge whose amount they decompose: a transaction has either none of them, or a set that sums to its amount exactly and shares its sign.",
      liveness: { kind: "must-target-live" },
    },
  },
  wish: {
    "WishCandidate.wishId": {
      role: "owned-child",
      label: "tool candidates",
      description:
        "An alternative tool Product belonging to this Wishlist entry; the pairing has no independent meaning once the Wish is removed.",
      liveness: { kind: "must-target-live" },
    },
  },
  expense: {
    "ExpenseAttribution.expenseId": {
      role: "composition",
      label: "party shares",
      description:
        "Unitless beneficiary or initial-funder weights that allocate this Expense without storing money.",
      liveness: { kind: "must-target-live" },
    },
    "LedgerSourceClaim.expenseId": {
      role: "metadata",
      label: "import source references",
      description:
        "Durable external identity proving which normalized source row became this Expense.",
      liveness: { kind: "must-target-live" },
    },
  },
  ledgerTransfer: {
    "FinancialTransaction.ledgerTransferId": {
      role: "reference",
      label: "evidence transactions",
      description: "Posted settlement evidence for this transfer.",
      liveness: { kind: "must-target-live" },
    },
    "LedgerSourceClaim.ledgerTransferId": {
      role: "metadata",
      label: "source claims",
      description: "Canonical external evidence claimed by this transfer.",
      liveness: { kind: "must-target-live" },
    },
  },
  planting: {
    "Planting.parentPlantingId": {
      role: "history",
      label: "split plantings",
      description:
        "A child planting retains the source planting that it was split from.",
      liveness: { kind: "must-target-live" },
    },
    "GardenEntry.plantingId": {
      role: "history",
      label: "garden entries",
      description:
        "Garden observations and harvests retain the planting they describe.",
      liveness: { kind: "must-target-live" },
    },
    "PlantingLocationPeriod.plantingId": {
      role: "history",
      label: "location history",
      description: "A confirmed interval belongs to its planting.",
      liveness: { kind: "must-target-live" },
    },
  },
  gardenEntry: {
    "GardenEntryImage.gardenEntryId": {
      role: "media",
      label: "entry photos",
      description:
        "Photos attached to this garden entry have no independent meaning once it is removed.",
      liveness: { kind: "must-target-live" },
    },
    "PlantingLocationPeriod.sourceGardenEntryId": {
      role: "history",
      label: "location-history source entries",
      description:
        "A workflow-created period retains the entry that records its start.",
      liveness: { kind: "must-target-live" },
    },
  },
  inventory: {},
  "usda-food": {},
} as const satisfies { [E in Entity]: IncomingEdgeMap<E, EdgeSemantics> };
