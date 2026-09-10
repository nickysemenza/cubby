import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "recipe",
  names: { singular: "Recipe", plural: "Recipes" },
  route: { basePath: "recipes" },
  table: "Recipe",
  identifiers: { brand: "RecipeId", shortcode: "RCP-", legacy: null },
  presentation: { titleField: "name" },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text", section: "identity" },
        display: { list: true, detail: true, standard: "name" },
        validation: {
          kind: "string",
          write: { trim: true, min: 1, minMessage: "Recipe name is required" },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "meta",
        kind: "json",
        nullable: true,
        control: { kind: "specialized", renderer: "structured-field" },
        display: { detail: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/recipe-shared",
            export: "recipeMeta",
          },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "yield",
        kind: "json",
        nullable: true,
        control: { kind: "specialized", renderer: "structured-field" },
        display: { detail: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/recipe-shared",
            export: "recipeYieldSchema",
          },
          nullable: true,
          optional: true,
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "servings",
        kind: "number",
        nullable: true,
        control: { kind: "number", section: "servings" },
        display: { list: true, detail: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/recipe-shared",
            export: "recipeServings",
          },
          nullable: true,
          optional: true,
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "tags",
        kind: "text-array",
        nullable: true,
        control: { kind: "specialized", renderer: "tag-list" },
        display: { detail: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/recipe-shared",
            export: "recipeTags",
          },
          nullable: true,
          optional: true,
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        description: "Optional. Supports Markdown.",
        control: { kind: "textarea" },
        display: { list: true, detail: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/recipe-shared",
            export: "recipeNotes",
          },
          nullable: true,
          optional: true,
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "sections",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        display: { detail: true },
        validation: {
          kind: "source",
          write: {
            source: {
              module: "@cubby/schemas/recipe-fields",
              export: "recipeSectionsInput",
            },
          },
          read: {
            source: {
              module: "@cubby/schemas/recipe-fields",
              export: "recipeSectionsOut",
            },
          },
          create: true,
          update: true,
        },
      },
      {
        key: "pendingImageIds",
        kind: "identifier",
        label: "Pending Image IDs",
        readKey: null,
        reference: { entity: "image", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        validation: {
          kind: "array",
          item: {
            kind: "source",
            source: {
              module: "@cubby/schemas/identifiers",
              export: "imageShortcode",
            },
          },
          optional: true,
          create: true,
          update: true,
        },
      },
      {
        key: "removeImageIds",
        kind: "identifier",
        label: "Remove Image IDs",
        readKey: null,
        reference: { entity: "image", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        validation: {
          update: {
            kind: "array",
            item: {
              kind: "source",
              source: {
                module: "@cubby/schemas/identifiers",
                export: "imageShortcode",
              },
            },
          },
        },
      },
      {
        key: "imageOrder",
        kind: "text",
        readKey: null,
        control: { kind: "specialized", renderer: "image-order" },
        validation: {
          update: {
            kind: "array",
            item: {
              kind: "source",
              source: {
                module: "@cubby/schemas/identifiers",
                export: "imageShortcode",
              },
            },
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
              export: "recipeShortcode",
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
      {
        key: "source",
        kind: "text",
        nullable: true,
        display: { list: true, detail: true },
        validation: {
          read: {
            kind: "source",
            source: {
              module: "@cubby/schemas/recipe-shared",
              export: "recipeSource",
            },
            nullable: true,
            optional: true,
          },
        },
      },
      {
        key: "totals",
        kind: "json",
        nullable: true,
        display: { detail: true },
        validation: {
          read: {
            kind: "source",
            source: {
              module: "@cubby/schemas/recipe-shared",
              export: "recipeTotals",
            },
            nullable: true,
            optional: true,
          },
        },
      },
      {
        key: "images",
        kind: "json",
        display: { list: true, standard: "image", columnId: "image" },
        validation: {
          read: {
            kind: "array",
            item: {
              kind: "source",
              source: { module: "@cubby/schemas/image", export: "imageOut" },
            },
          },
        },
      },
      { key: "shortcode", kind: "text", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
      { key: "SourceType", kind: "enum", nullable: true, readKey: "source" },
      { key: "SourceData", kind: "text", nullable: true, readKey: "source" },
      {
        key: "cookbookId",
        kind: "identifier",
        nullable: true,
        label: "Cookbook ID",
        readKey: null,
        reference: { entity: "cookbook" },
      },
      {
        key: "totalsComputedAt",
        kind: "timestamp",
        nullable: true,
        readKey: null,
      },
      { key: "activeMinutes", kind: "number", nullable: true, readKey: null },
      { key: "totalMinutes", kind: "number", nullable: true, readKey: null },
    ],
    storage: [
      { key: "id", default: "generated", specialized: "primary-key:RecipeId" },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
      { key: "SourceType", specialized: "enum:RecipeSource" },
      "SourceData",
      { key: "cookbookId", reference: "cookbook" },
      { key: "yield", specialized: "json:yield" },
      "servings",
      { key: "tags", specialized: "text-array" },
      "notes",
      { key: "totals", specialized: "json:totals" },
      "totalsComputedAt",
      "activeMinutes",
      "totalMinutes",
      { key: "meta", specialized: "json:meta" },
    ],
    create: [
      "name",
      "meta",
      "yield",
      "servings",
      "tags",
      "notes",
      "sections",
      "pendingImageIds",
    ],
    update: [
      "name",
      "meta",
      "yield",
      "servings",
      "tags",
      "notes",
      "sections",
      "pendingImageIds",
      "removeImageIds",
      "imageOrder",
    ],
    bulk: [],
    audit: ["name"],
    output: [
      "id",
      "name",
      "createdAt",
      "updatedAt",
      "meta",
      "source",
      "yield",
      "servings",
      "tags",
      "notes",
      "sections",
      "totals",
      "images",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/recipe", export: "recipeCreateInput" },
    update: { module: "@cubby/schemas/recipe", export: "recipeUpdateData" },
    output: { module: "@cubby/schemas/recipe", export: "recipeOut" },
    list: { module: "@cubby/schemas/recipe", export: "recipeListItemOut" },
    mcpOutput: {
      module: "@cubby/schemas/recipe",
      export: "recipeMcpEntityOut",
    },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/recipe", export: "recipeFilterFields" },
    descriptors: [
      {
        columnId: "name",
        field: "nameFilter",
        kind: "text",
        placeholder: "Filter by recipe name...",
        deriveSchema: true,
      },
      {
        columnId: "tags",
        field: "tagFilters",
        kind: "multiselect",
        placeholder: "Filter by tag...",
        optionsKey: "tags",
        nullable: { field: "tagsPresenceFilter", label: "tags" },
      },
      {
        columnId: "source",
        field: "cookbookId",
        kind: "idMulti",
        placeholder: "Filter by cookbook...",
        optionsKey: "cookbook",
        brandRef: { entity: "cookbook", kind: "id" },
        nullable: { field: "cookbookPresenceFilter", label: "cookbook" },
      },
      {
        columnId: "meals",
        field: "mealPresenceFilter",
        kind: "presence",
        placeholder: "Filter meals...",
        options: [
          { value: "has", label: "Has meals", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "image",
        field: "imagePresenceFilter",
        kind: "presence",
        placeholder: "Filter images...",
        options: [
          { value: "has", label: "Has image", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "instructions",
        field: "instructionsPresenceFilter",
        kind: "presence",
        placeholder: "Filter instructions...",
        options: [
          { value: "has", label: "Has instructions", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "sourceType",
        field: "sourceTypeFilter",
        kind: "multiselect",
        placeholder: "Filter by source...",
        options: [
          { value: "Book", label: "Book" },
          { value: "Website", label: "Website" },
          { value: "Other", label: "Other" },
          { value: "Notion", label: "Notion" },
        ],
        nullable: { field: "sourceTypePresenceFilter", label: "source" },
      },
      {
        columnId: "costTotal",
        kind: "range",
        placeholder: "Filter recipe cost...",
        options: [
          { value: "under10", label: "Under $10" },
          { value: "10to25", label: "$10–$25" },
          { value: "25plus", label: "$25 and up" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveRecipeCost",
        },
      },
      {
        columnId: "caloriesTotal",
        kind: "range",
        placeholder: "Filter calories...",
        options: [
          { value: "under500", label: "Under 500 cal" },
          { value: "500to1000", label: "500–1,000 cal" },
          { value: "1000plus", label: "1,000+ cal" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveCalories",
        },
      },
      {
        columnId: "totalMinutes",
        kind: "range",
        placeholder: "Filter total time...",
        deriveSchema: true,
        options: [
          { value: "under30", label: "Under 30 min" },
          { value: "30to60", label: "30–60 min" },
          { value: "60plus", label: "Over an hour" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveRecipeTotalTime",
        },
      },
      {
        columnId: "related:recipe.ingredients",
        field: "ingredientId",
        urlKey: "related-ingredient",
        kind: "idMulti",
        placeholder: "Filter by ingredient...",
        optionsKey: "recipeIngredients",
        brandRef: { entity: "ingredient", kind: "id" },
        nullable: { field: "ingredientPresenceFilter", label: "ingredient" },
      },
      {
        columnId: "related:recipe.meals",
        field: "mealSearch",
        urlKey: "related-meal",
        kind: "text",
        placeholder: "Search related meals...",
      },
      {
        columnId: "mealId",
        kind: "idMulti",
        placeholder: "Filter by related meals id...",
        urlOnly: true,
      },
      {
        columnId: "mealPresenceFilter",
        kind: "presence",
        placeholder: "Filter related meals presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "cookbook",
      label: "Cookbook",
      target: "cookbook",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Recipe.cookbookId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Recipe.cookbookId", direction: "incoming" }],
      },
    },
    {
      key: "images",
      label: "Images",
      target: "image",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "RecipeImage.recipeId", direction: "incoming" },
          { edge: "RecipeImage.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "RecipeImage.imageId", direction: "incoming" },
          { edge: "RecipeImage.recipeId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "ingredients",
      label: "Ingredients",
      target: "ingredient",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "RecipeSection.recipeId", direction: "incoming" },
          {
            edge: "RecipeSectionIngredient.recipeSectionId",
            direction: "incoming",
          },
          {
            edge: "RecipeSectionIngredient.ingredientId",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "RecipeSectionIngredient.ingredientId",
            direction: "incoming",
          },
          {
            edge: "RecipeSectionIngredient.recipeSectionId",
            direction: "outgoing",
          },
          { edge: "RecipeSection.recipeId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "sub-recipes",
      label: "Sub-recipes",
      target: "recipe",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "RecipeSection.recipeId", direction: "incoming" },
          {
            edge: "RecipeSectionIngredient.recipeSectionId",
            direction: "incoming",
          },
          {
            edge: "RecipeSectionIngredient.ingredientId",
            direction: "outgoing",
          },
          { edge: "Ingredient.recipeId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Ingredient.recipeId", direction: "incoming" },
          {
            edge: "RecipeSectionIngredient.ingredientId",
            direction: "incoming",
          },
          {
            edge: "RecipeSectionIngredient.recipeSectionId",
            direction: "outgoing",
          },
          { edge: "RecipeSection.recipeId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "meals",
      label: "Meals",
      target: "meal",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealRecipe.recipeId", direction: "incoming" },
          { edge: "MealRecipe.mealId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealRecipe.mealId", direction: "incoming" },
          { edge: "MealRecipe.recipeId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: true,
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
    mcpNames: { overrides: { delete: "delete_recipe" } },
    ports: {
      repository: {
        module: "~/server/repo/recipe/entity-adapter",
        export: "recipeEntityAdapter",
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
