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
  name: entitySchema,
  /** pgTable name (matches schema.ts), or null for entities with no local table. */
  dbTable: z.string().nullable(),
  /** Branded id type name, for display; null where ids are unbranded/external. */
  idBrand: z.string().nullable(),
  /** Has a `deletedAt` soft-delete column. */
  softDelete: z.boolean(),
  /** Writes rows to the audit log (drives the audit entity union). */
  auditable: z.boolean(),
  /** Can carry images (drives the image entity enum). */
  hasImages: z.boolean(),
  /** Has a local, soft-deletable table we can count (drives entity counts). */
  countable: z.boolean(),
  /** Non-default count filter, beyond `notDeleted`. */
  countFilter: z.enum(["recipeIdNull"]).optional(),
  /** Entities this one points AT via a foreign key (directed reference graph). */
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
    name: "product",
    dbTable: "Product",
    idBrand: "ProductId",
    softDelete: true,
    auditable: true,
    hasImages: true,
    countable: true,
    references: ["ingredient"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  recipe: {
    name: "recipe",
    dbTable: "Recipe",
    idBrand: "RecipeId",
    softDelete: true,
    auditable: true,
    hasImages: true,
    countable: true,
    references: ["cookbook"],
    mcp: ALL_MCP,
    routerStyle: "custom",
  },
  ingredient: {
    name: "ingredient",
    dbTable: "Ingredient",
    idBrand: "IngredientId",
    softDelete: true,
    auditable: true,
    hasImages: false,
    countable: true,
    // Rows with a non-null recipeId are recipe-as-ingredient pointers, not real
    // ingredients — the list/count surfaces exclude them.
    countFilter: "recipeIdNull",
    references: ["recipe"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  cookbook: {
    name: "cookbook",
    dbTable: "Cookbook",
    idBrand: "CookbookId",
    softDelete: true,
    auditable: true,
    hasImages: true,
    countable: true,
    references: ["image"],
    mcp: ["list"],
    routerStyle: "custom",
  },
  location: {
    name: "location",
    dbTable: "Location",
    idBrand: "LocationId",
    softDelete: true,
    auditable: true,
    hasImages: true,
    countable: true,
    references: ["location"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  inventory: {
    name: "inventory",
    dbTable: "InventoryEntry",
    idBrand: "InventoryId",
    softDelete: true,
    auditable: true,
    hasImages: false,
    countable: true,
    references: ["product", "location"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  meal: {
    name: "meal",
    dbTable: "Meal",
    idBrand: "MealId",
    softDelete: true,
    auditable: true,
    hasImages: false,
    countable: true,
    references: ["recipe"],
    mcp: ALL_MCP,
    routerStyle: "crud-factory",
  },
  "usda-food": {
    name: "usda-food",
    dbTable: null,
    idBrand: null,
    softDelete: false,
    auditable: false,
    hasImages: false,
    countable: false,
    references: [],
    mcp: ["get", "list"],
    routerStyle: "custom",
  },
  image: {
    name: "image",
    dbTable: "Image",
    idBrand: null,
    softDelete: true,
    auditable: false,
    hasImages: false,
    countable: true,
    references: [],
    mcp: [],
    routerStyle: "custom",
  },
} as const satisfies Record<Entity, EntityDescriptor>;

export type EntityManifest = typeof entityManifest;

/** All entities, in manifest declaration order. */
export const allEntities = Object.keys(entityManifest) as Entity[];

// ---------------------------------------------------------------------------
// Derived projections — the meta-lists that previously lived as hand-maintained
// tuples scattered across the package. These `as const` tuples preserve literal
// types for zod `.extract()` / `.enum()`; entity-manifest.unit.test.ts asserts
// each one stays in sync with the descriptor flags above (the drift guard).
// ---------------------------------------------------------------------------

/** Entities that write audit-log rows (drives `auditEntitySchema`). */
export const auditableEntities = [
  "product",
  "recipe",
  "ingredient",
  "cookbook",
  "location",
  "inventory",
  "meal",
] as const;

/** Entities that can carry images (drives `entityImage`). */
export const imageEntities = [
  "product",
  "recipe",
  "cookbook",
  "location",
] as const;

/** Entities with a local soft-deletable table we can count. */
export const countableEntities = [
  "product",
  "recipe",
  "ingredient",
  "cookbook",
  "location",
  "inventory",
  "meal",
  "image",
] as const;

export type AuditableEntity = (typeof auditableEntities)[number];
export type CountableEntity = (typeof countableEntities)[number];
