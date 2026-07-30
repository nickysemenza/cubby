import { SHORTCODE_PREFIX } from "@cubby/shared";
import { z } from "zod";
import { type Entity, entitySchema } from "./entity";

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
  /** Human-readable shortcode prefix (e.g. "P-"), if the entity has shortcodes. */
  shortcodePrefix: z.string().optional(),
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
   * Entities this one points AT in the reference graph — via a direct FK column,
   * a join table (recipe→ingredient through recipeSectionIngredient, product→image
   * through productImage), or a cross-system id link (product→usda-food through
   * `fdc_id`, since USDA foods live in a separate worker, not a local FK). Every
   * image-bearing entity references `image`.
   */
  references: z.array(entitySchema).readonly(),
  /** CRUD operations exposed over MCP. */
  mcp: z.array(mcpOp).readonly(),
  /** Whether the tRPC router is built from the shared crud-factory or hand-rolled. */
  routerStyle: z.enum(["crud-factory", "custom"]),
});
export type EntityDescriptor = z.infer<typeof entityDescriptor>;

const ALL_MCP = ["get", "list", "create", "update", "delete"] as const;

export const entityManifest = {
  product: {
    dbTable: "Product",
    idBrand: "ProductId",
    shortcodePrefix: SHORTCODE_PREFIX.product,
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: true,
    countable: true,
    references: ["ingredient", "image", "usda-food"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  recipe: {
    dbTable: "Recipe",
    idBrand: "RecipeId",
    shortcodePrefix: SHORTCODE_PREFIX.recipe,
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: true,
    countable: true,
    // recipe→recipe: a recipe can use another recipe as a sub-recipe ingredient
    // (the sub-recipe dependency the costing/availability engines cascade through).
    references: ["cookbook", "ingredient", "image", "recipe"],
    mcp: ALL_MCP,
    routerStyle: "custom",
  },
  ingredient: {
    dbTable: "Ingredient",
    idBrand: "IngredientId",
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    // Rows with a non-null recipeId are recipe-as-ingredient pointers, not real
    // ingredients — the list/count surfaces exclude them.
    countFilter: "recipeIdNull",
    references: ["recipe"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  cookbook: {
    dbTable: "Cookbook",
    idBrand: "CookbookId",
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: true,
    countable: true,
    references: ["image"],
    mcp: ["list"],
    routerStyle: "custom",
  },
  location: {
    dbTable: "Location",
    idBrand: "LocationId",
    shortcodePrefix: SHORTCODE_PREFIX.location,
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: true,
    countable: true,
    references: ["location", "image"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  inventory: {
    dbTable: "InventoryEntry",
    idBrand: "InventoryId",
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    references: ["product", "location"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  meal: {
    dbTable: "Meal",
    idBrand: "MealId",
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    references: ["recipe"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  project: {
    dbTable: "Project",
    idBrand: "ProjectId",
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: true,
    countable: true,
    // project→project: Blocked-by/Blocking dependency edges (ProjectDependency).
    references: ["project", "image"],
    mcp: ALL_MCP,
    routerStyle: "custom",
  },
  task: {
    dbTable: "Task",
    idBrand: "TaskId",
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    // task→task: Blocked-by/Blocking dependency edges (TaskDependency).
    // task→product: optional subject — the thing this work is for.
    references: ["project", "product", "task"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  // A thin roster of the places money goes. Deliberately minimal in v1 —
  // contractor metadata (license, COI expiry) and vendor-level documents (W-9,
  // contracts) are the natural follow-ons once the roster exists.
  vendor: {
    dbTable: "Vendor",
    idBrand: "VendorId",
    softDelete: true,
    auditable: true,
    hasImages: false,
    // Out of the embedding pipeline in v1: a vendor is a name, and the ledger
    // rows that mention it are already indexed.
    searchable: false,
    countable: true,
    references: [],
    // No delete: `deleteVendors` refuses while live charges still reference the
    // vendor, and an agent has no way to rehome them.
    mcp: ["get", "list", "create", "update"],
    routerStyle: "custom",
  },
  // ONE vendor transaction — identity (`vendorId` + optional `orderId`), the
  // charge date, an optional `statedTotal` that is never summed into spend, and
  // its documents. Money lives on the expenses below it.
  purchase: {
    dbTable: "Purchase",
    idBrand: "PurchaseId",
    softDelete: true,
    auditable: true,
    hasImages: true,
    searchable: false,
    countable: true,
    references: ["vendor", "image"],
    // No delete: soft-deleting a charge nulls `purchaseId` on real money. The
    // restructuring ops (split/link/merge) stay UI-only for the same reason —
    // subtle refusal semantics an agent can't be trusted with yet.
    mcp: ["get", "list", "create", "update"],
    routerStyle: "custom",
  },
  expense: {
    dbTable: "Expense",
    idBrand: "ExpenseId",
    softDelete: true,
    auditable: true,
    hasImages: false,
    searchable: true,
    countable: true,
    references: ["purchase", "project", "product"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  "usda-food": {
    dbTable: null,
    idBrand: null,
    softDelete: false,
    auditable: false,
    hasImages: false,
    searchable: false,
    countable: false,
    references: [],
    mcp: ["get", "list"],
    routerStyle: "custom",
  },
  image: {
    dbTable: "Image",
    idBrand: null,
    softDelete: true,
    auditable: false,
    hasImages: false,
    searchable: false,
    countable: true,
    references: [],
    mcp: [],
    routerStyle: "custom",
  },
} as const satisfies Record<Entity, EntityDescriptor>;

export type EntityManifest = typeof entityManifest;

/** All entities, in manifest declaration order. */
export const allEntities = Object.keys(entityManifest) as Entity[];

/**
 * Outgoing reference edges of an entity, widened from the `as const` manifest
 * tuple to `readonly Entity[]` (so `.includes(someEntity)` typechecks).
 */
export const entityReferences = (e: Entity): readonly Entity[] =>
  entityManifest[e].references;

// ---------------------------------------------------------------------------
// Derived projections — the manifest flags are the only rosters. The conditional
// type preserves each projection's literal entity union for zod and consumers.
// ---------------------------------------------------------------------------

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

export type AuditableEntity = (typeof auditableEntities)[number];
export type CountableEntity = (typeof countableEntities)[number];
export type SearchableEntity = (typeof searchableEntities)[number];
