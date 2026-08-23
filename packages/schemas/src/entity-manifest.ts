import { SHORTCODE_PREFIX } from "@cubby/shared";
import { z } from "zod";
import type { Entity } from "./entity-core";
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
 * It declares WHAT each entity is and how they relate, and is kept honest by the
 * drift test in entity-manifest.unit.test.ts.
 *
 * It is now also mildly GENERATIVE, which reverses an earlier boundary and is
 * worth stating plainly. This file used to promise it "does NOT generate
 * per-entity logic". `mcpNames` + `mcpToolName` break that promise on purpose:
 * the naming table they replace lived in `server.unit.test.ts`, so the manifest
 * said which MCP operations existed while a hand-kept copy in a test decided
 * what they were called. Declaring a name next to the operation it names is the
 * point of a manifest.
 *
 * The boundary that still holds: this file owns DECLARATIONS, never behavior.
 * Zod modules, repos, routers, and tool handlers stay where they are — see the
 * argument in `entity-lifecycle-registry.ts` for why the same split applies to
 * edge policies.
 */
const mcpOp = z.enum(["get", "list", "create", "update", "delete"]);

export const entityDescriptor = z.object({
  /** pgTable name (matches schema.ts), or null for entities with no local table. */
  dbTable: z.string().nullable(),
  /** Branded id type name, for display; null where ids are unbranded/external. */
  idBrand: z.string().nullable(),
  /**
   * The entity's public-id prefix (e.g. "PRD-"). Present on every entity with a
   * local table. Absent means "this entity has no public id" — today only
   * `usda-food`, which is an external identifier (`fdc_id`) with no local table.
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
  /**
   * Departures from the default MCP tool naming. Absent means the defaults hold.
   *
   * The names themselves used to live in a `Record<Entity, …>` inside
   * `server.unit.test.ts` — a hand-kept table in a TEST file, which the same
   * test then compared against the live catalog. So the manifest declared WHICH
   * operations exist while something untracked decided what they were CALLED,
   * and only a test run could tell you the two agreed.
   */
  mcpNames: z
    .object({
      /** Overrides `snakeCase(entity)`. */
      singular: z.string().optional(),
      /** Overrides `${singular}s`. */
      plural: z.string().optional(),
      /** Per-operation overrides, for tools whose verb isn't the default. */
      overrides: z.partialRecord(mcpOp, z.string()).optional(),
    })
    .optional(),
});
export type EntityDescriptor = z.infer<typeof entityDescriptor>;

/** `financialAccount` → `financial_account`, `usda-food` → `usda_food`. */
const snakeCase = (entity: string) =>
  entity
    .replace(/-/g, "_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();

/**
 * The MCP tool name for an (entity, operation) pair.
 *
 * `list` and `delete` act on a set, so they take the plural; the rest are
 * singular. That rule was previously reimplemented inline in the drift test.
 */
/**
 * The plural slug an entity's set-shaped tools use. Batch tools are
 * `create_${plural}` / `update_${plural}`, which is why this is exposed
 * separately from {@link mcpToolName} — those are plural even though their
 * singular counterparts are not.
 */
export const mcpEntityPlural = (entity: Entity): string => {
  // Read through the declared type: the manifest literal is a union of 17
  // object types and only some declare `mcpNames`, so a direct property access
  // on the union does not compile even though every member satisfies
  // `EntityDescriptor`.
  // Widened to `EntityDescriptor` first: the manifest literal is a union of 17
  // object types and only some declare `mcpNames`, so reading the property off
  // the union does not compile even though every member satisfies the type.
  const descriptor: EntityDescriptor = entityManifest[entity];
  const names = descriptor.mcpNames;
  return names?.plural ?? `${names?.singular ?? snakeCase(entity)}s`;
};

export const mcpToolName = (
  entity: Entity,
  operation: z.infer<typeof mcpOp>,
): string => {
  const descriptor: EntityDescriptor = entityManifest[entity];
  const names = descriptor.mcpNames;
  const override = names?.overrides?.[operation];
  if (override) return override;
  const singular = names?.singular ?? snakeCase(entity);
  const plural = names?.plural ?? `${singular}s`;
  return `${operation}_${operation === "list" || operation === "delete" ? plural : singular}`;
};

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
      // Not one column: an explicit `fdc_id` wins, and a product with none
      // still reaches a branded food through its barcode, so declaring only
      // `fdc_id` would understate how a product actually gets to a food. The
      // barcode is no longer a Product column — it is a `gtin` external-id row.
      external("usda-food", "USDA food", "usda-food", "usda-api", [
        "ProductExternalId.externalId",
        "Product.fdc_id",
      ]),
    ],
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: true },
    mcp: ALL_MCP,
    mcpNames: { overrides: { list: "search_products" } },
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
    mcpNames: { overrides: { delete: "delete_recipe" } },
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
    mcpNames: { overrides: { list: "search_ingredients" } },
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
      // The physical copy on the shelf; null for EPUB-only cookbooks.
      path("product", "Product", "product", out("Cookbook.productId")),
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
    mcpNames: {
      singular: "inventory_entry",
      plural: "inventory_entries",
      overrides: { list: "list_inventory" },
    },
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
    relationships: [
      path("logo", "Logo image", "image", out("Vendor.logoImageId")),
    ],
    // Deletable in the app (blocked while live purchases reference it), and
    // mergeable — two roster rows for one real vendor is a reported defect.
    lifecycle: { delete: { mode: "soft", bulk: true }, merge: true },
    // Delete is exposed now. It used to be withheld because `deleteVendors`
    // refuses while live purchases reference the vendor and "an agent has no
    // way to rehome them" — but that refusal is structured now: it names which
    // vendors blocked and how many purchases each still holds, which is exactly
    // what an agent needs to act. merge_vendors remains the better move when
    // the two rows are one real vendor.
    mcp: ["get", "list", "create", "update", "delete"],
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
    // Delete is exposed, but NOT the UI's operation: that one detaches real
    // money from its provenance. `delete_entity` dispatches purchase through
    // the require-empty policy instead (see `deleteDispatch` in
    // mcp/tools/_shared.ts), refusing anything still carrying live Expenses or
    // settlement allocations and naming which. The restructuring ops
    // (split/link/merge) live outside this CRUD roster.
    mcp: ["get", "list", "create", "update", "delete"],
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
    mcpNames: { plural: "wishes" },
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
    mcpNames: { overrides: { list: "search_usda_foods" } },
  },
  image: {
    dbTable: "Image",
    idBrand: "ImageId",
    shortcodePrefix: SHORTCODE_PREFIX.image,
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
