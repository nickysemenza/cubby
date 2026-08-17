import { SHORTCODE_PREFIX } from "@cubby/shared";
import { z } from "zod";
import type { Entity } from "./entity";
import {
  type EntityRelationship,
  entityLifecycleSchema,
  entityRelationshipSchema,
  type RelationshipPathStep,
} from "./entity-integrity";

/**
 * The canonical, layer-shared descriptor of every entity in the system. This is
 * the single source of truth for the entity META-lists that can be derived
 * (auditable set, image-bearing set, countable set) and the data behind the
 * `/entities` introspection page. It is pure data (no React/icons/routes) so the
 * server (repos, audit schema, counts) and the client (UI manifest) can both
 * read it.
 *
 * It does NOT generate per-entity logic — zod modules, repos, routers, and MCP
 * tools stay where they are; this only declares WHAT each entity is and how they
 * relate, and is kept honest by the drift test in entity-manifest.unit.test.ts.
 */
const mcpOp = z.enum(["get", "list", "create", "update", "delete"]);

export const entityDescriptor = z.object({
  /** pgTable name (matches schema.ts), or null for entities with no local table. */
  dbTable: z.string().nullable(),
  /** Branded id type name, for display; null where ids are unbranded/external. */
  idBrand: z.string().nullable(),
  /**
   * The entity's public-id prefix (e.g. "PRD-"). Present on every entity with a
   * local table except `image`, whose rows are only ever addressed through the
   * entity that owns them. Absent means "this entity has no public id".
   */
  shortcodePrefix: z.string().optional(),
  /**
   * The pre-cutover single-letter prefix, where one exists. Inbound only — kept
   * so QR labels printed before 2026-07 still resolve; nothing emits it.
   */
  legacyShortcodePrefix: z.string().optional(),
  /** Has a `deletedAt` soft-delete column. */
  softDelete: z.boolean(),
  /** Writes rows to the audit log (drives the audit entity union). */
  auditable: z.boolean(),
  /** Can carry images (drives the image entity enum). */
  hasImages: z.boolean(),
  /** Participates in global lexical/semantic search and entity embeddings. */
  searchable: z.boolean(),
  /** Has a local, soft-deletable table we can count (drives entity counts). */
  countable: z.boolean(),
  /** Non-default count filter, beyond `notDeleted`. */
  countFilter: z.enum(["recipeIdNull"]).optional(),
  /**
   * Entities this one points AT in the reference graph, each with the storage
   * mechanism that realizes it: a direct FK column, a join-table hop, a
   * multi-hop path, an unconstrained pointer, or a cross-system id link.
   *
   * This replaced a flat `Entity[]`. The old shape said *that* recipe reaches
   * ingredient but not *how*, so nothing could check the claim — the join-table
   * and cross-system entries were unguarded by any test. Declaring the FK path
   * makes every local relationship verifiable against Drizzle's own metadata
   * (see the path-traversal test in entity-manifest-fk.unit.test.ts), which is
   * the whole reason for the extra structure.
   */
  relationships: z.array(entityRelationshipSchema).readonly(),
  /** Which removal paths exist for this entity — drives the lifecycle registry. */
  lifecycle: entityLifecycleSchema,
  /** CRUD operations exposed over MCP. */
  mcp: z.array(mcpOp).readonly(),
});
export type EntityDescriptor = z.infer<typeof entityDescriptor>;

const ALL_MCP = ["get", "list", "create", "update", "delete"] as const;

// A path starts at the source entity's own table; each step moves to another
// table. `outgoing` walks an FK from the table HOLDING the column toward the
// table it points at; `incoming` walks it backwards, from the pointed-at table
// to the holder. So reaching image from product is two steps: incoming to the
// ProductImage join row, then outgoing to the Image it names.

const out = (edge: string) => ({ edge, direction: "outgoing" }) as const;
const inc = (edge: string) => ({ edge, direction: "incoming" }) as const;

/** A relationship realized by one or more real FK hops. */
const path = (
  key: string,
  label: string,
  target: Entity,
  ...steps: RelationshipPathStep[]
): EntityRelationship => ({
  key,
  label,
  target,
  provenance: { kind: "local-path", steps },
});

/** A relationship the app walks with no DB-level FK behind it. */
const unconstrained = (
  key: string,
  label: string,
  target: Entity,
  edge: string,
): EntityRelationship => ({
  key,
  label,
  target,
  provenance: { kind: "unconstrained", edge },
});

/** A link into a system with no local table. */
const external = (
  key: string,
  label: string,
  target: Entity,
  system: string,
  sourceColumns: string[],
): EntityRelationship => ({
  key,
  label,
  target,
  provenance: { kind: "external", system, sourceColumns },
});

/** The image gallery hop every image-bearing entity has: `<E>Image` join row. */
const imageGallery = (
  joinTable: string,
  fkColumn: string,
): EntityRelationship =>
  path(
    "images",
    "Images",
    "image",
    inc(`${joinTable}.${fkColumn}`),
    out(`${joinTable}.imageId`),
  );

export const entityManifest = {
  product: {
    dbTable: "Product",
    idBrand: "ProductId",
    shortcodePrefix: SHORTCODE_PREFIX.product,
    legacyShortcodePrefix: "P-",
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: true,
    countable: true,
    relationships: [
      path(
        "ingredient",
        "Ingredient",
        "ingredient",
        out("Product.ingredientId"),
      ),
      path(
        "project-uses",
        "Used on projects",
        "project",
        inc("ProjectToolUsage.productId"),
        out("ProjectToolUsage.projectId"),
      ),
      path(
        "wishes",
        "Wishlist candidates",
        "wish",
        inc("WishCandidate.productId"),
        out("WishCandidate.wishId"),
      ),
      // Locations that ARE an instance of this product, not stock held at one.
      path(
        "locations",
        "Serving as locations",
        "location",
        inc("Location.productId"),
      ),
      imageGallery("ProductImage", "productId"),
      // Not one column: the USDA link resolves UPC-first and falls back to an
      // explicit fdc_id (see usda-link-resolved-at-query-time), so declaring
      // only `fdc_id` would understate how a product actually reaches a food.
      external("usda-food", "USDA food", "usda-food", "usda-api", [
        "Product.upc",
        "Product.fdc_id",
      ]),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: true },
    mcp: ALL_MCP,
  },
  recipe: {
    dbTable: "Recipe",
    idBrand: "RecipeId",
    shortcodePrefix: SHORTCODE_PREFIX.recipe,
    legacyShortcodePrefix: "R-",
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: true,
    countable: true,
    relationships: [
      path("cookbook", "Cookbook", "cookbook", out("Recipe.cookbookId")),
      imageGallery("RecipeImage", "recipeId"),
      // Three hops: down into the recipe's sections, into each section's
      // ingredient lines, then out to the ingredient the line names.
      path(
        "ingredients",
        "Ingredients",
        "ingredient",
        inc("RecipeSection.recipeId"),
        inc("RecipeSectionIngredient.recipeSectionId"),
        out("RecipeSectionIngredient.ingredientId"),
      ),
      // The sub-recipe dependency the costing/availability engines cascade
      // through — and the one relationship in the manifest that is genuinely
      // four hops. It is the ingredient path above plus one more step: a
      // recipe used as an ingredient is an Ingredient row whose `recipeId`
      // points back at a Recipe, so the last hop leaves the ingredient graph
      // and re-enters the recipe graph. Nothing shorter expresses it: there is
      // no Recipe→Recipe column anywhere in the schema.
      path(
        "sub-recipes",
        "Sub-recipes",
        "recipe",
        inc("RecipeSection.recipeId"),
        inc("RecipeSectionIngredient.recipeSectionId"),
        out("RecipeSectionIngredient.ingredientId"),
        out("Ingredient.recipeId"),
      ),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: false },
    mcp: ALL_MCP,
  },
  ingredient: {
    dbTable: "Ingredient",
    idBrand: "IngredientId",
    shortcodePrefix: SHORTCODE_PREFIX.ingredient,
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    // Rows with a non-null recipeId are recipe-as-ingredient pointers, not real
    // ingredients — the list/count surfaces exclude them.
    countFilter: "recipeIdNull",
    relationships: [
      // A non-null recipeId makes this row a recipe-as-ingredient pointer.
      // Deliberately survives the recipe's deletion — see the
      // `allow-target-deleted` liveness rule on `Ingredient.recipeId`.
      path("recipe", "Recipe", "recipe", out("Ingredient.recipeId")),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: true },
    mcp: ALL_MCP,
  },
  cookbook: {
    dbTable: "Cookbook",
    idBrand: "CookbookId",
    shortcodePrefix: SHORTCODE_PREFIX.cookbook,
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: true,
    countable: true,
    relationships: [
      path("cover", "Cover image", "image", out("Cookbook.coverImageId")),
    ],
    // Non-bulk: deleting a cookbook cascades through every recipe it imported,
    // so it is one at a time and confirmed.
    lifecycle: { delete: { mode: "soft", bulk: false }, merge: false },
    mcp: ["list"],
  },
  location: {
    dbTable: "Location",
    idBrand: "LocationId",
    shortcodePrefix: SHORTCODE_PREFIX.location,
    legacyShortcodePrefix: "L-",
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: true,
    countable: true,
    relationships: [
      unconstrained(
        "parent",
        "Parent location",
        "location",
        "Location.parentId",
      ),
      // The SKU this location is an instance of; null for rooms and areas.
      path("product", "Product", "product", out("Location.productId")),
      imageGallery("LocationImage", "locationId"),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: false },
    mcp: ALL_MCP,
  },
  inventory: {
    dbTable: "InventoryEntry",
    idBrand: "InventoryId",
    shortcodePrefix: SHORTCODE_PREFIX.inventory,
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    relationships: [
      path("product", "Product", "product", out("InventoryEntry.productId")),
      path(
        "location",
        "Location",
        "location",
        out("InventoryEntry.locationId"),
      ),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: false },
    mcp: ALL_MCP,
  },
  meal: {
    dbTable: "Meal",
    idBrand: "MealId",
    shortcodePrefix: SHORTCODE_PREFIX.meal,
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    relationships: [
      path(
        "recipes",
        "Recipes",
        "recipe",
        inc("MealRecipe.mealId"),
        out("MealRecipe.recipeId"),
      ),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: false },
    mcp: ALL_MCP,
  },
  project: {
    dbTable: "Project",
    idBrand: "ProjectId",
    shortcodePrefix: SHORTCODE_PREFIX.project,
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: true,
    countable: true,
    relationships: [
      path(
        "parent",
        "Parent project",
        "project",
        out("Project.parentProjectId"),
      ),
      // Distinct from the parent hierarchy above: a separate join table, and a
      // separate meaning. Two relationships to the same target entity, which is
      // exactly why relationship keys are unique per source rather than keyed
      // by target.
      path(
        "blocked-by",
        "Blocked by",
        "project",
        inc("ProjectDependency.projectId"),
        out("ProjectDependency.blockedByProjectId"),
      ),
      path(
        "tools-used",
        "Reusable resources",
        "product",
        inc("ProjectToolUsage.projectId"),
        out("ProjectToolUsage.productId"),
      ),
      imageGallery("ProjectImage", "projectId"),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: false },
    mcp: ALL_MCP,
  },
  task: {
    dbTable: "Task",
    idBrand: "TaskId",
    shortcodePrefix: SHORTCODE_PREFIX.task,
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    relationships: [
      path("project", "Project", "project", out("Task.projectId")),
      // The optional subject — the thing this work is for.
      path(
        "subject",
        "Subject product",
        "product",
        out("Task.subjectProductId"),
      ),
      path("parent", "Parent task", "task", out("Task.parentTaskId")),
      path(
        "blocked-by",
        "Blocked by",
        "task",
        inc("TaskDependency.taskId"),
        out("TaskDependency.blockedByTaskId"),
      ),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: false },
    mcp: ALL_MCP,
  },
  // A thin roster of the places money goes. Deliberately minimal in v1 —
  // contractor metadata (license, COI expiry) and vendor-level documents (W-9,
  // contracts) are the natural follow-ons once the roster exists.
  vendor: {
    dbTable: "Vendor",
    idBrand: "VendorId",
    shortcodePrefix: SHORTCODE_PREFIX.vendor,
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    relationships: [],
    // Deletable in the app (blocked while live purchases reference it), and
    // mergeable — two roster rows for one real vendor is a reported defect.
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: true },
    // No delete: `deleteVendors` refuses while live purchases still reference the
    // vendor, and an agent has no way to rehome them.
    mcp: ["get", "list", "create", "update"],
  },
  // One vendor order/receipt event — identity (`vendorId` + optional `orderId`),
  // vendor date, literal `statedTotal` that is never summed into spend, and
  // its documents. Money lives on the expenses below it.
  purchase: {
    dbTable: "Purchase",
    idBrand: "PurchaseId",
    shortcodePrefix: SHORTCODE_PREFIX.purchase,
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: true,
    countable: true,
    relationships: [
      path("vendor", "Vendor", "vendor", out("Purchase.vendorId")),
      imageGallery("PurchaseImage", "purchaseId"),
      path(
        "financial-transactions",
        "Financial transactions",
        "financialTransaction",
        inc("FinancialTransactionAllocation.purchaseId"),
        out("FinancialTransactionAllocation.transactionId"),
      ),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: true },
    // No generic delete: the UI operation may detach real money. MCP exposes a
    // narrower delete_empty_purchases tool that refuses live Expense or
    // FinancialTransaction references. The restructuring ops (split/link/merge)
    // likewise live outside this CRUD roster and are registered directly in
    // purchase.tools.ts.
    mcp: ["get", "list", "create", "update"],
  },
  financialAccount: {
    dbTable: "FinancialAccount",
    idBrand: "FinancialAccountId",
    shortcodePrefix: SHORTCODE_PREFIX.financialAccount,
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    relationships: [],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: false },
    mcp: ALL_MCP,
  },
  financialTransaction: {
    dbTable: "FinancialTransaction",
    idBrand: "FinancialTransactionId",
    shortcodePrefix: SHORTCODE_PREFIX.financialTransaction,
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    relationships: [
      path(
        "account",
        "Financial account",
        "financialAccount",
        out("FinancialTransaction.accountId"),
      ),
      path(
        "purchase",
        "Purchase",
        "purchase",
        inc("FinancialTransactionAllocation.transactionId"),
        out("FinancialTransactionAllocation.purchaseId"),
      ),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: false },
    mcp: ALL_MCP,
  },
  wish: {
    dbTable: "Wish",
    idBrand: "WishId",
    shortcodePrefix: SHORTCODE_PREFIX.wish,
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    relationships: [
      path(
        "candidates",
        "Tool candidates",
        "product",
        inc("WishCandidate.wishId"),
        out("WishCandidate.productId"),
      ),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: false },
    mcp: ALL_MCP,
  },
  expense: {
    dbTable: "Expense",
    idBrand: "ExpenseId",
    shortcodePrefix: SHORTCODE_PREFIX.expense,
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    relationships: [
      path("purchase", "Purchase", "purchase", out("Expense.purchaseId")),
      path("project", "Project", "project", out("Expense.projectId")),
      path("product", "Product", "product", out("Expense.productId")),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: false },
    mcp: ALL_MCP,
  },
  "usda-food": {
    dbTable: null,
    idBrand: null,
    softDelete: false,
    auditable: false,
    hasImages: false,
    searchable: false,
    countable: false,
    relationships: [],
    // No local table, so nothing to remove.
    lifecycle: { delete: null, merge: false },
    mcp: ["get", "list"],
  },
  image: {
    dbTable: "Image",
    idBrand: null,
    softDelete: true,
    auditable: false,
    hasImages: false,
    searchable: false,
    countable: true,
    relationships: [],
    // The one HARD delete in the system: `deleteImages` removes the row and the
    // R2 object, so there is no tombstone to reason about.
    lifecycle: { delete: { mode: "hard", bulk: true }, merge: false },
    mcp: [],
  },
} as const satisfies Record<Entity, EntityDescriptor>;

export type EntityManifest = typeof entityManifest;

/** All entities, in manifest declaration order. */
export const allEntities = Object.keys(entityManifest) as Entity[];

/**
 * The distinct entities `e` points at, derived from its relationships.
 *
 * Deliberately lossy: two relationships can share a target (project's `parent`
 * and `blocked-by` both reach `project`), and this collapses them. It exists
 * for the graph views, which draw one edge per entity pair; anything that needs
 * to know *which* relationship, or how it is stored, reads `relationships`.
 */
export const entityReferences = (e: Entity): readonly Entity[] => [
  ...new Set(entityManifest[e].relationships.map((r) => r.target)),
];

// Derived projections — the manifest flags are the only rosters. The conditional
// type preserves each projection's literal entity union for zod and consumers.

type BooleanTrait = {
  [K in keyof EntityDescriptor]-?: NonNullable<
    EntityDescriptor[K]
  > extends boolean
    ? K
    : never;
}[keyof EntityDescriptor];

type EntityWithTrait<K extends BooleanTrait> = {
  [E in Entity]: EntityManifest[E] extends Record<K, true> ? E : never;
}[Entity];

const entitiesWithTrait = <K extends BooleanTrait>(
  trait: K,
): readonly EntityWithTrait<K>[] =>
  Object.freeze(
    allEntities.filter(
      (entity): entity is EntityWithTrait<K> =>
        (entityManifest[entity] as EntityDescriptor)[trait] === true,
    ),
  );

/** Entities that write audit-log rows (drives `auditEntitySchema`). */
export const auditableEntities = entitiesWithTrait("auditable");

/** Entities that can carry images (drives `entityImage`). */
export const imageEntities = entitiesWithTrait("hasImages");

/** Entities indexed by global lexical/semantic search. */
export const searchableEntities = entitiesWithTrait("searchable");

/** Entities with a local soft-deletable table we can count. */
export const countableEntities = entitiesWithTrait("countable");

/**
 * Entities addressable by a public shortcode — the roster behind the shortcode
 * resolvers, the shortcode detail routes, and every public MCP `id`. Derived
 * from the presence of `shortcodePrefix` rather than a second hand-kept list;
 * the drift test asserts it matches `ShortcodeType` in `@cubby/shared`.
 */
type EntityWithShortcode = {
  [E in Entity]: EntityManifest[E] extends { shortcodePrefix: string }
    ? E
    : never;
}[Entity];

export const shortcodeEntities: readonly EntityWithShortcode[] = Object.freeze(
  allEntities.filter(
    (entity): entity is EntityWithShortcode =>
      (entityManifest[entity] as EntityDescriptor).shortcodePrefix !==
      undefined,
  ),
);

export type ShortcodeEntity = EntityWithShortcode;

export type AuditableEntity = (typeof auditableEntities)[number];
export type CountableEntity = (typeof countableEntities)[number];
export type SearchableEntity = (typeof searchableEntities)[number];
