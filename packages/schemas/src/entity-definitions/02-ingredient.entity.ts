import { defineEntity } from "./definition.js";
import { ingredientShortcode } from "../identifier-fields.js";
import { baseKind } from "../codec.js";
import { z } from "zod";
export default defineEntity({
  key: "ingredient",
  names: { singular: "Ingredient", plural: "Ingredients" },
  route: { basePath: "ingredients" },
  table: "Ingredient",
  identifiers: { brand: "IngredientId", shortcode: "ING-", legacy: null },
  presentation: { titleField: "name" },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text", section: "identity" },
        display: { list: true, detail: true },
        validation: {
          read: z
            .string()
            .describe("Ingredient name")
            .meta({ mock: "food.ingredient" }),
          create: z
            .string()
            .trim()
            .min(1, "Ingredient name is required")
            .describe("Ingredient name")
            .meta({ mock: "food.ingredient" }),
          update: z
            .string()
            .trim()
            .min(1, "Ingredient name is required")
            .describe("New name")
            .meta({ mock: "food.ingredient" })
            .optional(),
        },
      },
      {
        key: "aliases",
        kind: "text-array",
        control: { kind: "specialized", renderer: "tag-list" },
        display: { list: true, detail: true },
        validation: {
          read: z
            .array(z.string())
            .describe("Alternate names for this ingredient"),
          create: z
            .array(z.string())
            .describe("Alternate names for this ingredient")
            .default([]),
          update: z
            .array(z.string())
            .optional()
            .describe("New aliases (replaces existing list)"),
        },
      },
      {
        key: "naKinds",
        kind: "text-array",
        label: "Enrichment exclusions",
        control: { kind: "specialized", renderer: "tag-list" },
        validation: {
          read: z.array(baseKind),
          create: z.array(baseKind).optional().default([]),
          update: z.array(baseKind).optional(),
        },
      },
      {
        key: "usuallyOnHand",
        kind: "boolean",
        label: "Usually on hand",
        description:
          "Assume I have enough for recipe planning. Recorded inventory stays separate.",
        control: { kind: "checkbox" },
        display: { list: true, detail: true },
        validation: {
          read: z.boolean(),
          create: z.boolean().optional().default(false),
          update: z.boolean().optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: ingredientShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { detail: true },
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      { key: "shortcode", kind: "text", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
      {
        key: "recipeId",
        kind: "identifier",
        nullable: true,
        label: "Recipe ID",
        readKey: null,
        reference: { entity: "recipe" },
      },
    ],
    storage: [
      {
        key: "id",
        default: "generated",
        specialized: "primary-key:IngredientId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "aliases",
        default: "literal",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      {
        key: "naKinds",
        default: "literal",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      { key: "usuallyOnHand", default: "literal", defaultValue: false },
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
      { key: "recipeId", reference: "recipe" },
    ],
    create: ["name", "aliases", "naKinds", "usuallyOnHand"],
    update: ["naKinds", "usuallyOnHand", "name", "aliases"],
    bulk: ["usuallyOnHand"],
    audit: ["name", "aliases", "naKinds", "usuallyOnHand"],
    sort: {
      fields: ["createdAt", "updatedAt", "name", "appearsInRecipes", "product"],
      default: "createdAt",
      computed: ["appearsInRecipes", "product"],
    },
    intents: {
      fields: {
        capture: ["name"],
        full: ["name", "aliases", "naKinds"],
        identity: ["name", "aliases"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
    output: [
      "id",
      "name",
      "aliases",
      "naKinds",
      "usuallyOnHand",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/ingredient",
      export: "ingredientCreateInput",
    },
    update: {
      module: "@cubby/schemas/ingredient",
      export: "ingredientUpdateData",
    },
    output: { module: "@cubby/schemas/ingredient", export: "ingredientOut" },
    list: {
      module: "@cubby/schemas/ingredient",
      export: "ingredientListItemOut",
    },
    detail: {
      module: "@cubby/schemas/ingredient",
      export: "ingredientWithFoodOut",
    },
    mcpList: {
      module: "@cubby/schemas/ingredient",
      export: "ingredientListItemMcpEntityOut",
    },
    mcpDetail: {
      module: "@cubby/schemas/ingredient",
      export: "ingredientWithFoodMcpEntityOut",
    },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/ingredient",
      export: "ingredientFilterFields",
    },
    descriptors: [
      {
        columnId: "name",
        field: "nameFilter",
        kind: "text",
        placeholder: "Filter by ingredient name...",
        deriveSchema: true,
        schemaDescription: "Filter by ingredient name (substring)",
      },
      {
        columnId: "product",
        field: "productPresenceFilter",
        kind: "presence",
        placeholder: "Filter product...",
        options: [
          { value: "has", label: "Has product", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "usuallyOnHand",
        field: "usuallyOnHand",
        kind: "boolean",
        placeholder: "Filter pantry staples...",
        deriveSchema: true,
        schemaDescription: "Filter by ingredients usually kept on hand",
        options: [
          { value: "true", label: "Usually on hand" },
          { value: "false", label: "Not usually on hand" },
        ],
      },
      {
        columnId: "ownRecipes",
        field: "ownRecipePresenceFilter",
        kind: "presence",
        placeholder: "Filter own recipes...",
        options: [
          { value: "has", label: "Has own recipes", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "appearsInRecipes",
        field: "recipePresenceFilter",
        kind: "presence",
        placeholder: "Filter recipes...",
        options: [
          { value: "has", label: "Has recipes", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
    ],
  },
  relations: [
    {
      key: "recipe",
      label: "Recipe",
      target: "recipe",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Ingredient.recipeId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Ingredient.recipeId", direction: "incoming" }],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: false,
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: { fields: ["usuallyOnHand"] },
    merge: true,
    operationOwners: { delete: "kernel", merge: "kernel" },
    mcp: [
      "get",
      "list",
      "search",
      "create",
      "update",
      "delete",
      "merge",
      "bulkUpdate",
    ],
  },
  extensions: {
    countFilter: "recipeIdNull",
    relatednessSignals: null,
    mcpNames: { overrides: { list: "search_ingredients" } },
    ports: {
      repository: {
        module: "~/server/repo/ingredient/entity-adapter",
        export: "ingredientEntityAdapter",
      },
      references: {
        label: { module: "~/entities/entities", export: "entityLabel" },
        resolver: {
          module: "~/server/repo/shortcode-resolver",
          export: "resolveLiveShortcode",
        },
      },
      filters: {
        module: "~/entities/filter-manifest",
        export: "getEntityFilters",
      },
      search: {
        projection: {
          module: "~/server/repo/search-document",
          export: "refreshSearchDocument",
        },
        semanticText: {
          module: "~/server/repo/search-document",
          export: "getSearchDocumentEmbeddingText",
        },
        dependentRefresh: {
          module: "~/server/services/mutation-side-effects",
          export: "runMutationSideEffects",
        },
      },
    },
  },
});
