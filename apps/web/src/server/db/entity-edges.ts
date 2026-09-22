/**
 * Single source of truth for every incoming foreign-key edge in the system —
 * for every entity `E`, every column (on some other table, usually a join
 * table) that carries a live reference to `E.id`, paired with that edge's
 * stable *meaning*.
 *
 * This used to be two hand-kept maps (`INCOMING_EDGES` in
 * `entity-incoming-edges.ts`, `ENTITY_EDGE_SEMANTICS` in
 * `entity-edge-semantics.ts`) held in parity by a `satisfies` clause and a
 * runtime key-set check. Both were really describing the same 21-entity,
 * ~70-edge set — one fact (which column, whether it's DB-constrained) and one
 * stable description of what the edge means (role, label, description,
 * liveness) — so a new edge had to be added twice, in lockstep, or the two
 * drifted. `ENTITY_EDGES` merges them: add an edge here once, and
 * `INCOMING_EDGES` / `ENTITY_EDGE_SEMANTICS` (real typed projections of this
 * map, in their original files) can never disagree with it or each other,
 * because there is only one place to disagree with.
 *
 * Lives in `server/db`, not `packages/schemas`: the `column` values are
 * `AnyColumn` references into `schema.ts`, and schemas cannot import
 * `drizzle-orm/pg-core` (see the AGENTS.md layering note on the WASM/schemas
 * boundary — this is the same shape of rule, one level down).
 *
 * **This map holds edges and their stable meaning only — never a
 * disposition.** What an operation should DO with an edge (hard-delete the
 * row, null the FK, refuse the parent delete, ignore it entirely) is not a
 * property of the edge itself: `image`'s edges disposition differently under
 * a hard delete (`deleteRow`/`clearFk` — see `IMAGE_HARD_DELETE` in
 * `repo/image.ts`) than they would under some other operation, and
 * `product`'s edges split into acquisition/history/metadata roles
 * differently again depending on which predicate is asking. A per-edge
 * global disposition would be wrong on the facts, not merely weak. Each
 * operation that cares still owns its own `IncomingEdgePolicy<E, ...>` (or a
 * stable role map keyed by it, e.g. `PRODUCT_EDGE_ROLES` in
 * `repo/product/edge-roles.ts`), so a new edge here is a compile error at
 * every operation until it has been given a disposition there. The runtime
 * key-set guard for those operation policies lives in
 * `repo/entity-edge-operation-policies.unit.test.ts`; the corresponding
 * repository integration tests backstop the actual SQL behavior.
 *
 * By contrast, `role` / `label` / `description` / `liveness` ARE stable
 * per-edge facts, not per-operation choices — that's `EdgeSemantics`
 * (`@cubby/schemas/entity-integrity`). "Stable" is the point: a `role`
 * describes what the edge represents in the domain (a photo, a ledger line, a
 * hierarchy pointer) — never what any particular operation does about it.
 * `Expense.purchaseId` is a `ledger` edge whether a purchase delete clears it
 * or a purchase merge re-points it; the role doesn't change because the
 * operation does. Nothing here encodes delete/merge/detach behavior, and
 * nothing here should ever need to change when an operation's policy changes.
 *
 * `liveness` is the one place this file *does* make a normative claim: for
 * almost every edge, a live source row pointing at a soft-deleted target is a
 * bug (`must-target-live`, the referential-liveness audit's invariant, see
 * `repo/problems/detectors-integrity.ts`). The lone exception is `recipe`'s
 * `"Ingredient.recipeId"` — see its own comment below.
 *
 * Cross-checked against schema.ts by entity-manifest-fk.unit.test.ts, which
 * introspects every `pgTable` in schema.ts and asserts:
 *   1. every real FK it finds pointing at an entity's table is declared here
 *      (the assertion that would have caught `PurchaseImage.imageId` missing
 *      from `image`'s edges — the bug this file exists to prevent recurring);
 *   2. every edge declared here that introspection does NOT find is marked
 *      `unconstrained` (catches typos/renames); and
 *   3. every FK target that is neither an entity nor in the test's
 *      `NON_ENTITY_FK_TARGETS` allowlist fails, forcing a one-line
 *      justification for stepping outside the entity graph.
 * That test deliberately does NOT derive edges from Drizzle FK metadata — it
 * only cross-checks this hand-declared set against it, so a schema change
 * can't silently redefine what an edge means.
 */

import type { Entity } from "@cubby/schemas/entity";
import type { EdgeLiveness, EdgeRole } from "@cubby/schemas/entity-integrity";
import type { AnyColumn } from "drizzle-orm";

import {
  aiUsage,
  auditLog,
  cookbook,
  device,
  expense,
  expenseAttribution,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  gardenEntry,
  gardenEntryImage,
  image,
  imageDerivative,
  imageDescriptionCorrection,
  imageProcessingJob,
  imageSighting,
  gardenEntryPlanting,
  importFinding,
  importHunt,
  importPreparedOrder,
  importRun,
  importRunApproval,
  importRunControlEvent,
  importRunEvidence,
  importRunMutation,
  importRunOperation,
  importRunOrderCandidate,
  importRunProgress,
  importRunTarget,
  importSourceClaim,
  ingredient,
  inventoryEntry,
  ledgerSourceClaim,
  ledgerTransfer,
  location,
  locationImage,
  mealImage,
  mealFoodEntry,
  mealRecipe,
  mealRecipePortion,
  mailboxCursor,
  merchantVendorRule,
  orderMail,
  orderMailAttachment,
  product,
  productCategory,
  productComponent,
  productConversionCoverage,
  productExternalId,
  productImage,
  productUnitMappings,
  project,
  projectDependency,
  projectImage,
  projectToolUsage,
  purchase,
  purchaseImage,
  purchasePaymentEvidence,
  purchaseProduct,
  recipe,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
  planting,
  statementRow,
  task,
  taskDependency,
  taskImage,
  vendor,
  vendorAccount,
  wishCandidate,
} from "./schema";

/** `${pgTable name}.${column name}` — e.g. `"PurchaseImage.imageId"`. */
type EdgeKey<C extends AnyColumn> = `${C["_"]["tableName"]}.${C["_"]["name"]}`;

export interface EntityEdge {
  /** The FK column, on the referencing table, that points at this entity's `id`. */
  column: AnyColumn;
  /**
   * What the edge represents in the domain — never what an operation does
   * about it. See {@link EdgeRole} for the closed vocabulary.
   */
  role: EdgeRole;
  /** Plural noun phrase naming the referencing rows, e.g. "recipes". */
  label: string;
  /** One or two sentences explaining what the edge means and why. */
  description: string;
  /**
   * Whether a live source row is allowed to point at a soft-deleted target.
   * Nearly every edge is `must-target-live`.
   */
  liveness: EdgeLiveness;
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

/**
 * Forces every entry's key to equal `EdgeKey<its own column>`. Drizzle
 * preserves a concretely-declared column's table name and column name as
 * literal string types (see `productImage.imageId`'s inferred type), so
 * key↔column correspondence is checkable even though completeness of the edge
 * SET is not — a mis-keyed entry (wrong table, wrong column, a typo) fails to
 * satisfy this and is a compile error at the `edges({...})` call site. Set
 * completeness is entity-manifest-fk.unit.test.ts's job, not this type's.
 */
type WellKeyed<T extends Record<string, EntityEdge>> = {
  [K in keyof T]: K extends EdgeKey<T[K]["column"]> ? unknown : never;
};

function edges<T extends Record<string, EntityEdge>>(t: T & WellKeyed<T>): T {
  return t;
}

export const ENTITY_EDGES = {
  cookbook: edges({
    "Recipe.cookbookId": {
      column: recipe.cookbookId,
      role: "owned-child",
      label: "recipes",
      description:
        "A recipe filed under this cookbook; deleting the cookbook takes its recipes with it.",
      liveness: { kind: "must-target-live" },
    },
  }),
  image: edges({
    "ImportRunTarget.imageId": {
      column: importRunTarget.imageId,
      role: "history",
      label: "photo import runs",
      description:
        "A photo-inventory run worklist row preserves the Image it grouped; it is not a gallery attachment.",
      liveness: { kind: "must-target-live" },
    },
    "ImageDerivative.imageId": {
      column: imageDerivative.imageId,
      role: "media",
      label: "image derivatives",
      description:
        "A transparent representation derived from this original image; it is never a gallery attachment of its own.",
      liveness: { kind: "must-target-live" },
    },
    "ImageProcessingJob.imageId": {
      column: imageProcessingJob.imageId,
      role: "metadata",
      label: "image processing jobs",
      description:
        "Durable processing state for this original image; queue delivery is only a wakeup for this record.",
      liveness: { kind: "must-target-live" },
    },
    "ImageDescriptionCorrection.imageId": {
      column: imageDescriptionCorrection.imageId,
      role: "metadata",
      label: "confirmed image descriptions",
      description:
        "A user-confirmed image description that remains separate from generated analysis history.",
      liveness: { kind: "must-target-live" },
    },
    "ImportPreparedOrder.primaryDocumentImageId": {
      column: importPreparedOrder.primaryDocumentImageId,
      role: "media",
      label: "prepared primary documents",
      description:
        "The primary source document retained by an immutable prepared import order.",
      liveness: { kind: "must-target-live" },
    },
    "ImportPreparedOrder.screenshotImageId": {
      column: importPreparedOrder.screenshotImageId,
      role: "media",
      label: "prepared screenshots",
      description:
        "The browser screenshot retained by an immutable prepared import order.",
      liveness: { kind: "must-target-live" },
    },
    "ImportHunt.receiptImageId": {
      column: importHunt.receiptImageId,
      role: "media",
      label: "receipt hunt evidence",
      description: "A receipt photo submitted to resolve an import hunt.",
      liveness: { kind: "must-target-live" },
    },
    "OrderMailAttachment.imageId": {
      column: orderMailAttachment.imageId,
      role: "media",
      label: "mail attachments",
      description: "A normalized document captured from an order email.",
      liveness: { kind: "must-target-live" },
    },
    "Cookbook.coverImageId": {
      column: cookbook.coverImageId,
      role: "media",
      label: "cookbook covers",
      description:
        "The cover photo for a cookbook, shown in cookbook lists and detail headers.",
      liveness: { kind: "must-target-live" },
    },
    "Vendor.logoImageId": {
      column: vendor.logoImageId,
      role: "media",
      label: "vendor logos",
      description:
        "An optional brand mark for a vendor; absence deliberately falls back to the vendor monogram.",
      liveness: { kind: "must-target-live" },
    },
    "ProductImage.imageId": {
      column: productImage.imageId,
      role: "media",
      label: "product photos",
      description:
        "A photo or manual attachment linked to a product; says nothing about whether the product was ever owned.",
      liveness: { kind: "must-target-live" },
    },
    "LocationImage.imageId": {
      column: locationImage.imageId,
      role: "media",
      label: "location photos",
      description:
        "A photo attached to a location — e.g. a picture of a shelf or bin.",
      liveness: { kind: "must-target-live" },
    },
    "RecipeImage.imageId": {
      column: recipeImage.imageId,
      role: "media",
      label: "recipe photos",
      description: "A photo attached to a recipe.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectImage.imageId": {
      column: projectImage.imageId,
      role: "media",
      label: "project photos",
      description: "A photo attached to a household project.",
      liveness: { kind: "must-target-live" },
    },
    "PurchaseImage.imageId": {
      column: purchaseImage.imageId,
      role: "media",
      label: "receipt attachments",
      description:
        "The emailed invoice PDF or a photo of the paper receipt attached to a purchase.",
      liveness: { kind: "must-target-live" },
    },
    "GardenEntryImage.imageId": {
      column: gardenEntryImage.imageId,
      role: "media",
      label: "garden entry photos",
      description: "A full-scene photo attached to a dated garden entry.",
      liveness: { kind: "must-target-live" },
    },
    "MealImage.imageId": {
      column: mealImage.imageId,
      role: "media",
      label: "meal photos",
      description: "A photo of a planned or prepared meal.",
      liveness: { kind: "must-target-live" },
    },
    "TaskImage.imageId": {
      column: taskImage.imageId,
      role: "media",
      label: "task photos",
      description: "A before/after or reference photo attached to a task.",
      liveness: { kind: "must-target-live" },
    },
    "ImageSighting.imageId": {
      column: imageSighting.imageId,
      role: "owned-child",
      label: "sightings",
      description:
        "A report of this image appearing in a member's photo library or cloud asset; meaningless without the original image.",
      liveness: { kind: "must-target-live" },
    },
  }),
  recipe: edges({
    "RecipeSection.recipeId": {
      column: recipeSection.recipeId,
      role: "composition",
      label: "recipe sections",
      description:
        'A named section (e.g. "For the crust") that structures this recipe\'s ingredient list; meaningless outside the recipe it belongs to.',
      liveness: { kind: "must-target-live" },
    },
    "Ingredient.recipeId": {
      column: ingredient.recipeId,
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
      column: mealRecipe.recipeId,
      role: "association",
      label: "meal-plan entries",
      description:
        "A join row placing this recipe on the meal calendar; the meal and the recipe each exist independently of the pairing.",
      liveness: { kind: "must-target-live" },
    },
    "RecipeImage.recipeId": {
      column: recipeImage.recipeId,
      role: "media",
      label: "recipe photos",
      description: "A photo attached to this recipe.",
      liveness: { kind: "must-target-live" },
    },
    "Recipe.forkedFromRecipeId": {
      column: recipe.forkedFromRecipeId,
      role: "hierarchy",
      label: "forks",
      description:
        "A recipe that records this one as the recipe it was forked from — a lineage pointer only, enforced by the Recipe self-FK.",
      liveness: { kind: "must-target-live" },
    },
  }),
  ingredient: edges({
    "MealFoodEntry.ingredientId": {
      column: mealFoodEntry.ingredientId,
      role: "usage",
      label: "meal food entries",
      description:
        "A recorded ingredient quantity assigned to an eater at a meal, retaining the ingredient as its authored source.",
      liveness: { kind: "must-target-live" },
    },
    "RecipeSectionIngredient.ingredientId": {
      column: recipeSectionIngredient.ingredientId,
      role: "usage",
      label: "recipe ingredient lines",
      description:
        "A line in a recipe section that calls for this ingredient with its own amount, unit, and note — a recipe reference, never an inventory decrement (nothing consumes stock as a side effect).",
      liveness: { kind: "must-target-live" },
    },
    "Product.ingredientId": {
      column: product.ingredientId,
      role: "reference",
      label: "products",
      description:
        "A purchasable product mapped to this ingredient — the one hop nutrition and costing resolve through (ingredient → product → fdc_id), never a direct link.",
      liveness: { kind: "must-target-live" },
    },
    "Product.growsIngredientId": {
      column: product.growsIngredientId,
      role: "reference",
      label: "garden source products",
      description:
        "A seed packet, seedling, or plant product can name the ingredient it grows without becoming edible inventory.",
      liveness: { kind: "must-target-live" },
    },
    "Planting.ingredientId": {
      column: planting.ingredientId,
      role: "history",
      label: "plantings",
      description: "A garden planting retains the crop ingredient it records.",
      liveness: { kind: "must-target-live" },
    },
  }),
  meal: edges({
    "MealFoodEntry.mealId": {
      column: mealFoodEntry.mealId,
      role: "composition",
      label: "food entries",
      description:
        "A product or manual food amount assigned to an eater at this meal; the entry has no meaning outside the meal that owns it.",
      liveness: { kind: "must-target-live" },
    },
    "MealRecipe.mealId": {
      column: mealRecipe.mealId,
      role: "composition",
      label: "planned recipes",
      description:
        "A recipe assigned to this meal; the pairing is part of what the meal consists of, not an independent association.",
      liveness: { kind: "must-target-live" },
    },
    "MealRecipePortion.mealId": {
      column: mealRecipePortion.mealId,
      role: "association",
      label: "served portions",
      description:
        "A recorded portion from a recipe preparation assigned for consumption at this meal, including portions from an earlier leftovers source.",
      liveness: { kind: "must-target-live" },
    },
    "MealImage.mealId": {
      column: mealImage.mealId,
      role: "media",
      label: "meal photos",
      description:
        "A photo of the plated dinner or preparation has no independent meaning once the meal is removed.",
      liveness: { kind: "must-target-live" },
    },
  }),
  ledgerParty: edges({
    "VendorAccount.ledgerPartyId": {
      column: vendorAccount.ledgerPartyId,
      role: "reference",
      label: "vendor accounts",
      description: "A member-owned login used for vendor import automation.",
      liveness: { kind: "must-target-live" },
    },
    "ImportRun.ledgerPartyId": {
      column: importRun.ledgerPartyId,
      role: "history",
      label: "import runs",
      description: "The member whose evidence was processed by an import run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportSourceClaim.ledgerPartyId": {
      column: importSourceClaim.ledgerPartyId,
      role: "history",
      label: "import source claims",
      description: "The member scope for an idempotent imported source.",
      liveness: { kind: "must-target-live" },
    },
    "ImportFinding.ledgerPartyId": {
      column: importFinding.ledgerPartyId,
      role: "history",
      label: "import findings",
      description: "The member whose import requires review.",
      liveness: { kind: "must-target-live" },
    },
    "ImportHunt.ledgerPartyId": {
      column: importHunt.ledgerPartyId,
      role: "history",
      label: "import hunts",
      description: "The member whose evidence is being sought.",
      liveness: { kind: "must-target-live" },
    },
    "MerchantVendorRule.ledgerPartyId": {
      column: merchantVendorRule.ledgerPartyId,
      role: "metadata",
      label: "merchant routing rules",
      description: "A member-scoped confirmed merchant-to-vendor route.",
      liveness: { kind: "must-target-live" },
    },
    "MailboxCursor.ledgerPartyId": {
      column: mailboxCursor.ledgerPartyId,
      role: "metadata",
      label: "mailbox cursors",
      description: "A member mailbox's durable Gmail history cursor.",
      liveness: { kind: "must-target-live" },
    },
    "OrderMail.ledgerPartyId": {
      column: orderMail.ledgerPartyId,
      role: "history",
      label: "order mail",
      description: "Normalized order evidence from a member mailbox.",
      liveness: { kind: "must-target-live" },
    },
    "MealFoodEntry.ledgerPartyId": {
      column: mealFoodEntry.ledgerPartyId,
      role: "association",
      label: "meal food entries",
      description:
        "A product or manual food amount naming this member or guest as its eater.",
      liveness: { kind: "must-target-live" },
    },
    "ExpenseAttribution.ledgerPartyId": {
      column: expenseAttribution.ledgerPartyId,
      role: "ledger",
      label: "beneficiary attributions",
      description:
        "A weighted expense beneficiary or funder share; money remains on the expense itself.",
      liveness: { kind: "must-target-live" },
    },
    "FinancialAccount.ledgerPartyId": {
      column: financialAccount.ledgerPartyId,
      role: "reference",
      label: "financial accounts",
      description:
        "The member or household party an evidence account belongs to.",
      liveness: { kind: "must-target-live" },
    },
    "InventoryEntry.ownerLedgerPartyId": {
      column: inventoryEntry.ownerLedgerPartyId,
      role: "reference",
      label: "owned inventory entries",
      description:
        "An explicit member or guest owner pinned on a current inventory slot.",
      liveness: { kind: "must-target-live" },
    },
    "LedgerTransfer.fromPartyId": {
      column: ledgerTransfer.fromPartyId,
      role: "ledger",
      label: "outgoing transfers",
      description: "A transfer source endpoint.",
      liveness: { kind: "must-target-live" },
    },
    "LedgerTransfer.toPartyId": {
      column: ledgerTransfer.toPartyId,
      role: "ledger",
      label: "incoming transfers",
      description: "A transfer target endpoint.",
      liveness: { kind: "must-target-live" },
    },
    "MealRecipePortion.ledgerPartyId": {
      column: mealRecipePortion.ledgerPartyId,
      role: "association",
      label: "meal portions",
      description:
        "A planned or confirmed recipe portion naming this member or guest as its eater.",
      liveness: { kind: "must-target-live" },
    },
    "Device.ledgerPartyId": {
      column: device.ledgerPartyId,
      role: "reference",
      label: "devices",
      description: "A native companion install owned by this member.",
      liveness: { kind: "must-target-live" },
    },
    "ImageSighting.ledgerPartyId": {
      column: imageSighting.ledgerPartyId,
      role: "reference",
      label: "image sightings",
      description:
        "The member whose photo library or cloud account a sighting was reported from.",
      liveness: { kind: "must-target-live" },
    },
    "Image.capturedByPartyId": {
      column: image.capturedByPartyId,
      role: "reference",
      label: "captured images",
      description:
        "The member an image's capture is derived (or manually confirmed) as belonging to.",
      liveness: { kind: "must-target-live" },
    },
  }),
  product: edges({
    "ImportRunTarget.productId": {
      column: importRunTarget.productId,
      role: "history",
      label: "targeted import runs",
      description:
        "A no-op validation or enrichment target preserves the Product it examined.",
      liveness: { kind: "must-target-live" },
    },
    "MealFoodEntry.productId": {
      column: mealFoodEntry.productId,
      role: "reference",
      label: "meal food entries",
      description:
        "A recorded product amount whose nutrition is recalculated from the current product source while its entered quantity remains fixed.",
      liveness: { kind: "must-target-live" },
    },
    "ProductExternalId.productId": {
      column: productExternalId.productId,
      role: "metadata",
      label: "external ids",
      description:
        "An external identifier (e.g. an ASIN) recorded against this product; says nothing about whether the product was ever owned.",
      liveness: { kind: "must-target-live" },
    },
    "ProductUnitMappings.productId": {
      column: productUnitMappings.productId,
      role: "metadata",
      label: "unit mappings",
      description:
        "A hand-entered conversion (volume ↔ weight ↔ price) for this product; authored data, not evidence of purchase.",
      liveness: { kind: "must-target-live" },
    },
    "InventoryEntry.productId": {
      column: inventoryEntry.productId,
      role: "acquisition",
      label: "inventory entries",
      description:
        "A shelf or bin count of this product currently on hand — proof it was actually acquired, not just cataloged.",
      liveness: { kind: "must-target-live" },
    },
    "ProductImage.productId": {
      column: productImage.productId,
      role: "media",
      label: "product photos",
      description:
        "A photo or manual attachment for this product; says nothing about ownership.",
      liveness: { kind: "must-target-live" },
    },
    "Expense.productId": {
      column: expense.productId,
      role: "acquisition",
      label: "expenses",
      description:
        "A spend-ledger line recording money spent acquiring this product — the source of its net cost and owned/sold window; an orphaned product would silently corrupt that derivation with no restore path.",
      liveness: { kind: "must-target-live" },
    },
    "Task.subjectProductId": {
      column: task.subjectProductId,
      role: "history",
      label: "tasks referencing them",
      description:
        "Durable work history performed on this product (e.g. a repair or maintenance task); deleting the subject would leave that history nameless.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectToolUsage.productId": {
      column: projectToolUsage.productId,
      role: "history",
      label: "project uses",
      description:
        "Durable history that this reusable tool or software Product was used on a household project; deleting the Product would leave that history nameless.",
      liveness: { kind: "must-target-live" },
    },
    "PurchaseProduct.productId": {
      column: purchaseProduct.productId,
      role: "acquisition",
      label: "purchase links",
      description:
        "The vendor order this Product was bought on. Provenance, not money — it exists because an order paid in installments is an `allocation` whose Expenses can never carry a productId, leaving the goods with no path back to the order.",
      liveness: { kind: "must-target-live" },
    },
    "WishCandidate.productId": {
      column: wishCandidate.productId,
      role: "association",
      label: "wishlist candidates",
      description:
        "A tool Product considered as an alternative for a household Wishlist entry; it is planning data, not inventory or spend.",
      liveness: { kind: "must-target-live" },
    },
    "Location.productId": {
      column: location.productId,
      role: "reference",
      label: "locations",
      description:
        "A Location that IS an instance of this Product — the bin, tote or rack itself, not stock held in it. Deleting the Product would leave those locations with neither a type nor an identity, since a linked location stops carrying its own `type`.",
      liveness: { kind: "must-target-live" },
    },
    "Cookbook.productId": {
      column: cookbook.productId,
      role: "reference",
      label: "cookbooks",
      description:
        "A Cookbook whose physical copy this Product is — the book on the shelf behind the imported EPUB. Deleting the Product leaves the cookbook and its recipes intact; only the shelf link goes.",
      liveness: { kind: "must-target-live" },
    },
    "ProductComponent.parentProductId": {
      column: productComponent.parentProductId,
      role: "composition",
      label: "kit components",
      description:
        "A row on this Product's own component list — what's inside it, when it's a kit or multi-pack. Deleting the kit takes its component list with it.",
      liveness: { kind: "must-target-live" },
    },
    "ProductComponent.componentProductId": {
      column: productComponent.componentProductId,
      role: "usage",
      label: "kits it's listed inside",
      description:
        "This Product cited as a part of another (kit) Product's component list, with its own quantity. The kit and the part remain independently real products; this only says the part is currently accounted for inside the kit.",
      liveness: { kind: "must-target-live" },
    },
    "ProductConversionCoverage.productId": {
      column: productConversionCoverage.productId,
      role: "metadata",
      label: "conversion coverage projections",
      description:
        "A rebuildable conversion-graph projection owned by this product.",
      liveness: { kind: "must-target-live" },
    },
    "Planting.sourceProductId": {
      column: planting.sourceProductId,
      role: "history",
      label: "source products",
      description:
        "A planting can retain the seed packet, seedling, or plant it came from.",
      liveness: { kind: "must-target-live" },
    },
    "Device.productId": {
      column: device.productId,
      role: "reference",
      label: "devices",
      description: "A device whose physical hardware is this Product.",
      liveness: { kind: "must-target-live" },
    },
  }),
  productCategory: edges({
    "ProductCategory.parentId": {
      column: productCategory.parentId,
      role: "hierarchy",
      label: "child categories",
      description:
        "A child category is classified beneath this parent in the bounded product taxonomy.",
      liveness: { kind: "must-target-live" },
    },
    "Product.categoryId": {
      column: product.categoryId,
      role: "reference",
      label: "products",
      description:
        "A product retains its chosen most-specific category until it is explicitly reassigned.",
      liveness: { kind: "must-target-live" },
    },
  }),
  location: edges({
    "InventoryEntry.locationId": {
      column: inventoryEntry.locationId,
      role: "contents",
      label: "inventory entries",
      description: "A product physically held at this location right now.",
      liveness: { kind: "must-target-live" },
    },
    "LocationImage.locationId": {
      column: locationImage.locationId,
      role: "media",
      label: "location photos",
      description: "A photo attached to this location.",
      liveness: { kind: "must-target-live" },
    },
    "Location.parentId": {
      column: location.parentId,
      role: "hierarchy",
      label: "sub-locations",
      description:
        "A child location nested under this one in the house → room → shelf → bin tree, enforced by the Location parent self-FK.",
      liveness: { kind: "must-target-live" },
    },
    "Planting.locationId": {
      column: planting.locationId,
      role: "contents",
      label: "current plantings",
      description:
        "A growing planting is currently in this garden location; a planned planting names where it will go.",
      liveness: { kind: "must-target-live" },
    },
    "GardenEntry.locationId": {
      column: gardenEntry.locationId,
      role: "history",
      label: "garden entries",
      description:
        "A garden entry retains the location where the observation happened.",
      liveness: { kind: "must-target-live" },
    },
  }),
  project: edges({
    "Project.parentProjectId": {
      column: project.parentProjectId,
      role: "hierarchy",
      label: "sub-projects",
      description:
        "A project nested under this one; sub-project dates and totals roll up into the parent's derived window.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectDependency.projectId": {
      column: projectDependency.projectId,
      role: "dependency",
      label: "blocked-by dependencies",
      description:
        "A dependency edge naming this project as the one blocked, waiting on another project to finish first.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectDependency.blockedByProjectId": {
      column: projectDependency.blockedByProjectId,
      role: "dependency",
      label: "blocking dependencies",
      description:
        "A dependency edge naming this project as the blocker another project is waiting on.",
      liveness: { kind: "must-target-live" },
    },
    "Task.projectId": {
      column: task.projectId,
      role: "owned-child",
      label: "tasks",
      description:
        "A task filed under this project; deleting the project takes its tasks with it.",
      liveness: { kind: "must-target-live" },
    },
    "Purchase.defaultProjectId": {
      column: purchase.defaultProjectId,
      role: "ledger",
      label: "purchase defaults",
      description:
        "The default project inherited by purchase items without an override.",
      liveness: { kind: "must-target-live" },
    },
    "Expense.projectId": {
      column: expense.projectId,
      role: "ledger",
      label: "expenses",
      description:
        "A spend-ledger line rolled up under this project — all money lives on Expense, so this is the source of the project's cost total.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectImage.projectId": {
      column: projectImage.projectId,
      role: "media",
      label: "project photos",
      description: "A photo attached to this project.",
      liveness: { kind: "must-target-live" },
    },
    "ProjectToolUsage.projectId": {
      column: projectToolUsage.projectId,
      role: "association",
      label: "reusable resources",
      description:
        "A durable association recording a reusable tool or software Product used on this exact project.",
      liveness: { kind: "must-target-live" },
    },
  }),
  task: edges({
    "Task.parentTaskId": {
      column: task.parentTaskId,
      role: "hierarchy",
      label: "sub-tasks",
      description: "A child task nested under this one.",
      liveness: { kind: "must-target-live" },
    },
    "TaskDependency.taskId": {
      column: taskDependency.taskId,
      role: "dependency",
      label: "blocked-by dependencies",
      description:
        "A dependency edge naming this task as the one blocked, waiting on another task to finish first.",
      liveness: { kind: "must-target-live" },
    },
    "TaskDependency.blockedByTaskId": {
      column: taskDependency.blockedByTaskId,
      role: "dependency",
      label: "blocking dependencies",
      description:
        "A dependency edge naming this task as the blocker another task is waiting on.",
      liveness: { kind: "must-target-live" },
    },
    "TaskImage.taskId": {
      column: taskImage.taskId,
      role: "media",
      label: "task photos",
      description:
        "A before/after or reference photo has no independent meaning once the task is removed.",
      liveness: { kind: "must-target-live" },
    },
    "Planting.taskId": {
      column: planting.taskId,
      role: "history",
      label: "plantings",
      description: "A planting retains the task whose completion produced it.",
      liveness: { kind: "must-target-live" },
    },
  }),
  vendor: edges({
    "ImportRun.vendorId": {
      column: importRun.vendorId,
      role: "history",
      label: "import runs",
      description:
        "A durable import run tied directly to its vendor when no vendor account supplies that scope.",
      liveness: { kind: "must-target-live" },
    },
    "VendorAccount.vendorId": {
      column: vendorAccount.vendorId,
      role: "reference",
      label: "vendor accounts",
      description: "A member-owned login for this vendor.",
      liveness: { kind: "must-target-live" },
    },
    "ImportHunt.vendorId": {
      column: importHunt.vendorId,
      role: "history",
      label: "import hunts",
      description: "A charge-side evidence search routed to this vendor.",
      liveness: { kind: "must-target-live" },
    },
    "MerchantVendorRule.vendorId": {
      column: merchantVendorRule.vendorId,
      role: "metadata",
      label: "merchant routing rules",
      description: "A confirmed normalized merchant route to this vendor.",
      liveness: { kind: "must-target-live" },
    },
    "OrderMail.vendorId": {
      column: orderMail.vendorId,
      role: "history",
      label: "order mail",
      description: "Normalized mailbox evidence classified to this vendor.",
      liveness: { kind: "must-target-live" },
    },
    "Purchase.vendorId": {
      column: purchase.vendorId,
      role: "transaction",
      label: "purchases",
      description:
        "A vendor order/receipt event recorded against this vendor (identified by orderId when one is issued), not the spend ledger or a card charge — the Vendor ──< Purchase ──< Expense chain.",
      liveness: { kind: "must-target-live" },
    },
  }),
  purchase: edges({
    "ImportRunTarget.purchaseId": {
      column: importRunTarget.purchaseId,
      role: "history",
      label: "targeted import runs",
      description:
        "A validation target preserves the Purchase it examined without claiming a business mutation.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Purchase deletion preserves targeted-run history (see PURCHASE_DELETE_EDGE_POLICY), so the run target deliberately retains the Purchase tombstone.",
      },
    },
    "ImportSourceClaim.purchaseId": {
      column: importSourceClaim.purchaseId,
      role: "history",
      label: "import source claims",
      description: "The idempotency claim that produced this purchase.",
      liveness: { kind: "must-target-live" },
    },
    "PurchasePaymentEvidence.purchaseId": {
      column: purchasePaymentEvidence.purchaseId,
      role: "transaction",
      label: "payment evidence",
      description:
        "A captured shipment or order payment tied to this purchase.",
      liveness: { kind: "must-target-live" },
    },
    "Expense.purchaseId": {
      column: expense.purchaseId,
      role: "ledger",
      label: "expenses",
      description:
        "A categorized line of spend booked against this purchase. All money lives on Expense.cost; the purchase's own statedTotal is a soft reconciliation cue and is never summed into spend.",
      liveness: { kind: "must-target-live" },
    },
    "PurchaseImage.purchaseId": {
      column: purchaseImage.purchaseId,
      role: "media",
      label: "receipt attachments",
      description:
        "The invoice PDF or a photo of the paper receipt attached to this purchase.",
      liveness: { kind: "must-target-live" },
    },
    "PurchaseProduct.purchaseId": {
      column: purchaseProduct.purchaseId,
      role: "association",
      label: "products",
      description:
        "A Product this order bought. Carries no money — spend stays entirely on Expense — so this never doubles as a second ledger path.",
      liveness: { kind: "must-target-live" },
    },
    "FinancialTransactionAllocation.purchaseId": {
      column: financialTransactionAllocation.purchaseId,
      role: "transaction",
      label: "settlement allocations",
      description:
        "A slice of one card or bank transaction attributed to this purchase. One real charge can settle several purchases, so the slice — not the whole transaction — is what this order settled. The amount is evidence only; spend remains SUM(Expense.cost).",
      liveness: { kind: "must-target-live" },
    },
  }),
  financialAccount: edges({
    "FinancialTransaction.accountId": {
      column: financialTransaction.accountId,
      role: "transaction",
      label: "financial transactions",
      description:
        "A settlement-side event recorded by this financial account.",
      liveness: { kind: "must-target-live" },
    },
    "StatementRow.accountId": {
      column: statementRow.accountId,
      role: "reference",
      label: "statement rows",
      description:
        "A provider statement line an agent judged to belong to this account. Evidence Cubby is reconciled against, not a settlement event: the row is what the export said, and assigning it an account is a human judgment rather than something the import derived.",
      liveness: { kind: "must-target-live" },
    },
  }),
  financialTransaction: edges({
    "ImportHunt.financialTransactionId": {
      column: importHunt.financialTransactionId,
      role: "history",
      label: "import hunts",
      description: "An evidence hunt opened for an unallocated transaction.",
      liveness: { kind: "must-target-live" },
    },
    "FinancialTransactionAllocation.transactionId": {
      column: financialTransactionAllocation.transactionId,
      role: "composition",
      label: "purchase allocations",
      description:
        "One slice of this transaction's amount, attributed to a single Purchase. The slices are meaningless apart from the charge whose amount they decompose: a transaction has either none of them, or a set that sums to its amount exactly and shares its sign.",
      liveness: { kind: "must-target-live" },
    },
  }),
  wish: edges({
    "WishCandidate.wishId": {
      column: wishCandidate.wishId,
      role: "owned-child",
      label: "tool candidates",
      description:
        "An alternative tool Product belonging to this Wishlist entry; the pairing has no independent meaning once the Wish is removed.",
      liveness: { kind: "must-target-live" },
    },
  }),
  expense: edges({
    "ExpenseAttribution.expenseId": {
      column: expenseAttribution.expenseId,
      role: "composition",
      label: "party shares",
      description:
        "Unitless beneficiary or initial-funder weights that allocate this Expense without storing money.",
      liveness: { kind: "must-target-live" },
    },
    "LedgerSourceClaim.expenseId": {
      column: ledgerSourceClaim.expenseId,
      role: "metadata",
      label: "import source references",
      description:
        "Durable external identity proving which normalized source row became this Expense.",
      liveness: { kind: "must-target-live" },
    },
  }),
  ledgerTransfer: edges({
    "FinancialTransaction.ledgerTransferId": {
      column: financialTransaction.ledgerTransferId,
      role: "reference",
      label: "evidence transactions",
      description: "Posted settlement evidence for this transfer.",
      liveness: { kind: "must-target-live" },
    },
    "LedgerSourceClaim.ledgerTransferId": {
      column: ledgerSourceClaim.ledgerTransferId,
      role: "metadata",
      label: "source claims",
      description: "Canonical external evidence claimed by this transfer.",
      liveness: { kind: "must-target-live" },
    },
  }),
  planting: edges({
    "GardenEntryPlanting.plantingId": {
      column: gardenEntryPlanting.plantingId,
      role: "history",
      label: "garden entries",
      description:
        "Garden observations and harvests retain the planting they describe.",
      liveness: { kind: "must-target-live" },
    },
  }),
  gardenEntry: edges({
    "GardenEntryPlanting.gardenEntryId": {
      column: gardenEntryPlanting.gardenEntryId,
      role: "history",
      label: "planting associations",
      description:
        "A live association records which growing attempts a garden entry describes.",
      liveness: { kind: "must-target-live" },
    },
    "GardenEntryImage.gardenEntryId": {
      column: gardenEntryImage.gardenEntryId,
      role: "media",
      label: "entry photos",
      description:
        "Photos attached to this garden entry have no independent meaning once it is removed.",
      liveness: { kind: "must-target-live" },
    },
  }),
  // No table carries a live FK at these two: `inventory` is a leaf stock row,
  // and `usda-food` has no local table at all (it's resolved at query time via
  // `product.fdc_id`, a cross-system id link rather than a DB FK — see
  // usda-link-resolved-at-query-time).
  inventory: edges({}),
  vendorAccount: edges({
    "ImportRunTarget.vendorAccountId": {
      column: importRunTarget.vendorAccountId,
      role: "history",
      label: "targeted import runs",
      description:
        "A targeted validation or enrichment target retains the selected member-owned vendor account that supplied its evidence.",
      liveness: { kind: "must-target-live" },
    },
    "Purchase.vendorAccountId": {
      column: purchase.vendorAccountId,
      role: "reference",
      label: "purchases",
      description: "A purchase fetched through this member-owned vendor login.",
      liveness: { kind: "must-target-live" },
    },
    "ImportRun.vendorAccountId": {
      column: importRun.vendorAccountId,
      role: "history",
      label: "import runs",
      description: "A durable run executed for this vendor account.",
      liveness: { kind: "must-target-live" },
    },
    "ImportSourceClaim.vendorAccountId": {
      column: importSourceClaim.vendorAccountId,
      role: "history",
      label: "import source claims",
      description: "An idempotent source claim scoped to this vendor account.",
      liveness: { kind: "must-target-live" },
    },
    "ImportHunt.vendorAccountId": {
      column: importHunt.vendorAccountId,
      role: "history",
      label: "import hunts",
      description: "An evidence hunt assigned to this vendor account.",
      liveness: { kind: "must-target-live" },
    },
  }),
  // The read-only run record itself has no delete/merge operation
  // (`capabilities.delete: null`), so nothing here ever dispositions these
  // edges under a importRun operation — see entity-incoming-edges.ts's
  // doc comment. Child rows (target/evidence/mutation/operation/progress/
  // control-event/approval/prepared-order/order-candidate) exist only as part
  // of one run, so they're `owned-child`; rows other entities keep about a
  // run (purchases it touched, claims it advanced, findings it produced) are
  // `history`, mirroring vendorAccount's own edges above.
  importRun: edges({
    "AuditLog.runId": {
      column: auditLog.runId,
      role: "history",
      label: "audit entries",
      description: "An audit entry written as part of this run.",
      liveness: { kind: "must-target-live" },
    },
    "AiUsage.runId": {
      column: aiUsage.runId,
      role: "history",
      label: "AI usage",
      description: "One model call made as part of this run.",
      liveness: { kind: "must-target-live" },
    },
    "Purchase.importRunId": {
      column: purchase.importRunId,
      role: "history",
      label: "purchases",
      description: "A purchase this run imported or validated.",
      liveness: { kind: "must-target-live" },
    },
    "ImportRun.predecessorRunId": {
      column: importRun.predecessorRunId,
      role: "history",
      label: "successor runs",
      description: "A later run that continued from this one.",
      liveness: { kind: "must-target-live" },
    },
    "ImportRunTarget.runId": {
      column: importRunTarget.runId,
      role: "owned-child",
      label: "targets",
      description:
        "A validation or enrichment target recorded for this run; it has no independent meaning apart from the run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportRunOrderCandidate.runId": {
      column: importRunOrderCandidate.runId,
      role: "owned-child",
      label: "order candidates",
      description:
        "An account-sync order-history worklist row belonging to this run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportRunEvidence.runId": {
      column: importRunEvidence.runId,
      role: "owned-child",
      label: "evidence",
      description: "Captured evidence filed under this run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportRunMutation.runId": {
      column: importRunMutation.runId,
      role: "owned-child",
      label: "mutations",
      description:
        "An explicit row mutation attributed to this run, independent of AuditLog's actor shape.",
      liveness: { kind: "must-target-live" },
    },
    "ImportRunOperation.runId": {
      column: importRunOperation.runId,
      role: "owned-child",
      label: "operations",
      description: "One idempotent operation this run executed.",
      liveness: { kind: "must-target-live" },
    },
    "ImportRunProgress.runId": {
      column: importRunProgress.runId,
      role: "owned-child",
      label: "progress checkpoints",
      description: "A progress checkpoint recorded during this run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportRunControlEvent.runId": {
      column: importRunControlEvent.runId,
      role: "owned-child",
      label: "control events",
      description:
        "A prompt, pause, resume, or other control-plane event for this run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportPreparedOrder.runId": {
      column: importPreparedOrder.runId,
      role: "owned-child",
      label: "prepared orders",
      description: "Immutable prepared order evidence captured by this run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportRunApproval.runId": {
      column: importRunApproval.runId,
      role: "owned-child",
      label: "approvals",
      description: "An approval decision recorded against this run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportSourceClaim.firstRunId": {
      column: importSourceClaim.firstRunId,
      role: "history",
      label: "source claims (first seen)",
      description: "An idempotent source claim first captured by this run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportSourceClaim.lastRunId": {
      column: importSourceClaim.lastRunId,
      role: "history",
      label: "source claims (last seen)",
      description:
        "An idempotent source claim most recently confirmed by this run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportFinding.importRunId": {
      column: importFinding.importRunId,
      role: "history",
      label: "findings",
      description: "An integrity finding this run produced.",
      liveness: { kind: "must-target-live" },
    },
    "ImportHunt.receiptRunId": {
      column: importHunt.receiptRunId,
      role: "history",
      label: "receipt hunts",
      description: "An evidence hunt whose receipt this run captured.",
      liveness: { kind: "must-target-live" },
    },
  }),
  "usda-food": edges({}),
  device: edges({
    "AuditLog.deviceId": {
      column: auditLog.deviceId,
      role: "history",
      label: "audit entries",
      description:
        "An audit entry written from this install; the column is cleared when the device goes.",
      liveness: { kind: "must-target-live" },
    },
    "ImageSighting.deviceId": {
      column: imageSighting.deviceId,
      role: "owned-child",
      label: "image sightings",
      description:
        "A sighting reported by this device; meaningless without the reporting install.",
      liveness: { kind: "must-target-live" },
    },
  }),
  imageSighting: edges({}),
} as const satisfies Record<Entity, Record<string, EntityEdge>>;
