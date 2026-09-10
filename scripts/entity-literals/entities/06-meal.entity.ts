import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "meal",
  names: { singular: "Meal", plural: "Meals" },
  route: { basePath: "meals" },
  table: "Meal",
  identifiers: { brand: "MealId", shortcode: "MEL-", legacy: null },
  presentation: { titleField: "name" },
  model: {
    fields: [
      {
        key: "date",
        kind: "date",
        control: { kind: "date", section: "schedule" },
        display: { list: true, detail: true },
        validation: {
          kind: "source",
          source: { module: "@cubby/schemas/meal-shared", export: "mealDate" },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "name",
        kind: "text",
        nullable: true,
        control: { kind: "text" },
        display: { list: true, detail: true },
        validation: {
          kind: "string",
          nullable: true,
          write: { optional: true },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "sortOrder",
        kind: "number",
        nullable: true,
        control: { kind: "number", section: "ordering" },
        display: { list: true, detail: true },
        validation: {
          kind: "number",
          integer: true,
          nullable: true,
          write: { optional: true },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "mealType",
        kind: "enum",
        nullable: true,
        control: { kind: "select" },
        display: { list: true, detail: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/meal-classification",
            export: "mealTypeSchema",
          },
          nullable: true,
          write: {
            optional: true,
            description:
              "Which eating occasion of the day this is. Null when unslotted; the planning calendar orders a day's meals by it.",
          },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "mealKind",
        kind: "enum",
        control: { kind: "select" },
        display: { list: true, detail: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/meal-classification",
            export: "mealKindSchema",
          },
          write: {
            optional: true,
            description:
              "How the meal is eaten. Defaults to `cooked`. Use `eating_out`/`takeout` for a placeholder meal that intentionally has no recipes; only `cooked` meals feed the shopping list.",
          },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "recipes",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        display: { detail: true },
        validation: {
          kind: "array",
          read: {
            item: {
              kind: "source",
              source: {
                module: "@cubby/schemas/meal-fields",
                export: "mealRecipeOut",
              },
            },
          },
          create: {
            item: {
              kind: "source",
              source: {
                module: "@cubby/schemas/meal-fields",
                export: "mealRecipeInput",
              },
            },
            optional: true,
          },
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: {
            kind: "source",
            source: {
              module: "@cubby/schemas/identifiers",
              export: "mealShortcode",
            },
          },
        },
      },
      {
        key: "totals",
        kind: "json",
        display: { detail: true },
        validation: {
          read: {
            kind: "source",
            source: {
              module: "@cubby/schemas/meal-fields",
              export: "mealTotals",
            },
          },
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { detail: true },
        validation: { read: { kind: "timestamp" } },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
        validation: { read: { kind: "timestamp" } },
      },
      { key: "shortcode", kind: "text", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      { key: "id", default: "generated", specialized: "primary-key:MealId" },
      { key: "shortcode", specialized: "shortcode" },
      "date",
      "name",
      "sortOrder",
      { key: "mealType", specialized: "enum:mealType" },
      {
        key: "mealKind",
        default: "literal",
        defaultValue: "'cooked'",
        specialized: "enum:mealKind",
      },
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: ["date", "name", "sortOrder", "mealType", "mealKind", "recipes"],
    update: ["date", "name", "sortOrder", "mealType", "mealKind"],
    bulk: [],
    audit: [],
    output: [
      "id",
      "date",
      "name",
      "sortOrder",
      "mealType",
      "mealKind",
      "recipes",
      "totals",
      "createdAt",
      "updatedAt",
    ],
  },
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
        deriveSchema: true,
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
        deriveSchema: true,
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
