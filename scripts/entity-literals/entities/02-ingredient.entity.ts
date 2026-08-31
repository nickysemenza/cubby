import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "ingredient",
  names: { singular: "Ingredient", plural: "Ingredients" },
  route: { basePath: "ingredients" },
  table: "Ingredient",
  identifiers: { brand: "IngredientId", shortcode: "ING-", legacy: null },
  presentation: { titleField: "name" },
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
    bulkUpdate: null,
    merge: true,
    operationOwners: { delete: "kernel", merge: "kernel" },
    mcp: ["get", "list", "search", "create", "update", "delete", "merge"],
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
