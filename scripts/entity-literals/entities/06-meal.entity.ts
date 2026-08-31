import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "meal",
  names: { singular: "Meal", plural: "Meals" },
  route: { basePath: "meals" },
  table: "Meal",
  identifiers: { brand: "MealId", shortcode: "MEL-", legacy: null },
  presentation: { titleField: "name" },
  fields: {
    create: { module: "@cubby/schemas/meal", export: "mealCreateInput" },
    update: { module: "@cubby/schemas/meal", export: "mealUpdateData" },
    output: { module: "@cubby/schemas/meal", export: "mealOut" },
    mcpOutput: {
      module: "@cubby/schemas/meal",
      export: "mealMcpEntityOut",
    },
    mcpList: {
      module: "@cubby/schemas/meal",
      export: "mealMcpEntityOut",
    },
    mcpDetail: {
      module: "@cubby/schemas/meal",
      export: "mealMcpEntityOut",
    },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/meal", export: "mealFilterFields" },
    descriptors: [
      {
        columnId: "mealType",
        kind: "multiselect",
        placeholder: "Filter by meal type...",
        options: [
          { value: "breakfast", label: "Breakfast" },
          { value: "brunch", label: "Brunch" },
          { value: "lunch", label: "Lunch" },
          { value: "snack", label: "Snack" },
          { value: "dinner", label: "Dinner" },
          { value: "dessert", label: "Dessert" },
        ],
        nullable: { field: "mealTypePresenceFilter", label: "meal type" },
      },
      {
        columnId: "mealKind",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        options: [
          { value: "cooked", label: "Cooked", color: "var(--slate)" },
          { value: "leftovers", label: "Leftovers", color: "var(--slate)" },
          { value: "eating_out", label: "Eating out", color: "var(--primary)" },
          {
            value: "takeout",
            label: "Takeout / delivery",
            color: "var(--primary)",
          },
          { value: "other", label: "Other", color: "var(--slate)" },
        ],
      },
      {
        columnId: "recipeCostCoverage",
        field: "recipeCostCoverage",
        kind: "select",
        placeholder: "Filter recipe cost coverage...",
        options: [{ value: "understated", label: "Understated" }],
      },
      {
        columnId: "related:meal.recipes",
        field: "recipePresenceFilter",
        urlKey: "related-recipe",
        kind: "presence",
        placeholder: "Filter recipes...",
        options: [
          { value: "has", label: "Has recipes", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "recipeId",
        kind: "idMulti",
        placeholder: "Filter by related recipe id...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "recipes",
      label: "Recipes",
      target: "recipe",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealRecipe.mealId", direction: "incoming" },
          { edge: "MealRecipe.recipeId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealRecipe.recipeId", direction: "incoming" },
          { edge: "MealRecipe.mealId", direction: "outgoing" },
        ],
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
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/meal/entity-adapter",
        export: "mealEntityAdapter",
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
