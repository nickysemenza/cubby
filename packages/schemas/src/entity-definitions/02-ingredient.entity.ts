import { defineEntity } from "./definition.js";
import { ingredientShortcode } from "../identifier-fields.js";
import { baseKind } from "../codec.js";
import { z } from "zod";

export default defineEntity({
  key: "ingredient",
  names: { singular: "Ingredient", plural: "Ingredients" },
  route: {
    basePath: "ingredients",
    create: "dialog",
    list: true,
    detail: true,
  },
  table: "Ingredient",
  identifiers: { brand: "IngredientId", shortcode: "ING-" },
  presentation: {
    titleField: "name",
    domain: "cook",
    description: "Canonical cooking ingredients and aliases.",
    emptyState: {
      title: "Your pantry list is empty",
      description:
        "Build a list of ingredients to connect your recipes with what's in stock.",
      actionLabel: "Add Ingredient",
    },
    icons: { lucide: "Carrot", sfSymbol: "leaf", emoji: "🥕" },
    detail: {
      omitRelations: {
        eaters:
          "Who ate it is per-portion meal data; the Meals table on this page shows each meal and its eaters.",
      },
      sections: [
        {
          kind: "fields",
          id: "basic-information",
          title: "Basic information",
          placement: "supporting",
          fields: [
            "name",
            "aliases",
            "usuallyOnHand",
            "createdAt",
            "updatedAt",
          ],
        },
        { kind: "slot", id: "nutrition-product", title: "Nutrition" },
        {
          kind: "relation",
          id: "products",
          title: "Products",
          relation: "products",
          filter: { descriptor: "ingredient" },
          columns: ["name", "manufacturer", "category", "onHandUnits"],
        },
        {
          kind: "relation",
          id: "plants",
          title: "Plants",
          relation: "plants",
          filter: { descriptor: "ingredientId" },
          columns: ["name", "gardenGuideKey", "verdict"],
          hideWhenEmpty: true,
          placement: "supporting",
        },
        {
          kind: "relation",
          id: "recipes",
          title: "Appears in recipes",
          relation: "recipes",
          filter: { descriptor: "related:recipe.ingredients" },
          columns: ["name", "tags", "meals"],
        },
      ],
    },
    list: {
      actions: ["setUsuallyOnHand", "merge", "delete"],
      links: [
        { label: "Equivalences", path: "/ingredients/equivalences" },
        { label: "Workbench", path: "/ingredients/workbench" },
      ],
    },
  },
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
        capture: ["name", "aliases", "usuallyOnHand"],
        full: ["name", "aliases", "naKinds", "usuallyOnHand"],
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
        stored: true,
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
      {
        columnId: "related:ingredient.meals",
        field: "mealSearch",
        urlKey: "related-meal",
        kind: "text",
        placeholder: "Search related meals...",
      },
      {
        columnId: "mealId",
        kind: "idMulti",
        placeholder: "Filter by related meals id...",
        brandRef: { entity: "meal" },
        urlOnly: true,
      },
      {
        columnId: "mealPresenceFilter",
        kind: "presence",
        placeholder: "Filter related meals presence...",
        urlOnly: true,
      },
      {
        columnId: "related:ingredient.eaters",
        field: "eaterSearch",
        urlKey: "related-eater",
        kind: "text",
        placeholder: "Search related eaters...",
      },
      {
        columnId: "eaterId",
        kind: "idMulti",
        placeholder: "Filter by related eaters id...",
        brandRef: { entity: "ledgerParty" },
        urlOnly: true,
      },
      {
        columnId: "eaterPresenceFilter",
        kind: "presence",
        placeholder: "Filter related eaters presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "products",
      label: "Products",
      target: "product",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Product.ingredientId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Product.ingredientId", direction: "outgoing" }],
      },
    },
    {
      key: "plants",
      label: "Plants",
      target: "plant",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Plant.ingredientId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Plant.ingredientId", direction: "outgoing" }],
      },
    },
    {
      key: "recipes",
      label: "Recipes",
      target: "recipe",
      cardinality: "many",
      provenance: {
        kind: "local-path",
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
      inverse: {
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
    },
    {
      key: "recipe",
      label: "Recipe",
      target: "recipe",
      cardinality: "one",
      inverseOmit:
        "The recipe page is custom; its workflow slot shows where a recipe is used as an ingredient.",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Ingredient.recipeId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Ingredient.recipeId", direction: "incoming" }],
      },
    },
    {
      key: "meals",
      label: "Eaten at meals",
      target: "meal",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealFoodEntry.ingredientId", direction: "incoming" },
          { edge: "MealFoodEntry.mealId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealFoodEntry.mealId", direction: "incoming" },
          { edge: "MealFoodEntry.ingredientId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "eaters",
      label: "Eaten by",
      target: "ledgerParty",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealFoodEntry.ingredientId", direction: "incoming" },
          { edge: "MealFoodEntry.ledgerPartyId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealFoodEntry.ledgerPartyId", direction: "incoming" },
          { edge: "MealFoodEntry.ingredientId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: {
      storage: false,
      displaySources: [
        {
          relationPath: ["products"],
          priority: 0,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [
        {
          kind: "existingRelated",
          routeId: "ingredient-product",
          relationPath: ["products"],
          choice: "primary",
        },
        {
          kind: "createSelf",
          routeId: "ingredient-new",
          enabled: false,
          disabledReason:
            "Ingredients have no image storage of their own; attach photos via a product instead",
        },
      ],
      routing: {
        category: "food",
        candidateFields: ["name"],
        temporalFields: [],
        lifecycleFilters: [],
        signals: {
          ocrFields: ["name"],
          classifierLabels: ["vegetable", "fruit"],
        },
        abstention: { minimumScore: 0.78, minimumMargin: 0.16 },
      },
    },
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
    dataQuality: {
      checks: [
        {
          id: "ingredient_product",
          facet: "linkage",
          weight: 2,
          label: "Product link",
          message: "No product is linked to this ingredient.",
        },
      ],
    },
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
