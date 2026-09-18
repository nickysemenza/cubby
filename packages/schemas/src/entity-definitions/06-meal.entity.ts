import { defineEntity } from "./definition.js";
import { imageShortcode, mealShortcode } from "../identifier-fields.js";
import {
  mealKindSchema,
  mealTypeSchema,
} from "@cubby/schemas/meal-classification";
import {
  mealRecipeInput,
  mealRecipeOut,
  mealTotals,
} from "@cubby/schemas/meal-fields";
import { mealDate } from "@cubby/schemas/meal-shared";
import { imageOut } from "./field-primitives.js";
import { z } from "zod";
export default defineEntity({
  key: "meal",
  names: { singular: "Meal", plural: "Meals" },
  route: { basePath: "meals", create: "dialog", list: true, detail: true },
  table: "Meal",
  identifiers: { brand: "MealId", shortcode: "MEL-" },
  presentation: {
    titleField: "displayName",
    domain: "plan",
    description: "Dated meal plans and preparation records.",
    emptyState: {
      title: "No meals planned",
      description:
        "Plan recipes onto your calendar to see costs add up and build a shopping list.",
      actionLabel: "Plan a Meal",
    },
    icons: { lucide: "CalendarDays", sfSymbol: "fork.knife.circle" },
    detail: {
      hero: { images: true },
      sections: [
        { kind: "slot", id: "composition", title: "Recipes" },
        { kind: "slot", id: "nutrition", title: "Nutrition" },
        {
          kind: "fields",
          id: "meal-details",
          title: "Meal details",
          placement: "supporting",
          fields: [
            "date",
            "name",
            "mealType",
            "mealKind",
            "recipeNames",
            "sortOrder",
            "createdAt",
            "updatedAt",
          ],
        },
      ],
    },
    list: {
      views: [
        {
          kind: "slot",
          id: "calendar",
          label: "Calendar",
          searchKeys: ["period", "week", "date"],
        },
        {
          kind: "slot",
          id: "nutrition",
          label: "Nutrition",
          searchKeys: ["date"],
        },
        "table",
      ],
      actions: ["delete"],
      links: [{ label: "Shopping list", path: "/meals/shopping-list" }],
    },
  },
  model: {
    fields: [
      {
        key: "date",
        kind: "date",
        control: { kind: "date", section: "schedule", initial: "today" },
        display: { list: true, detail: true },
        validation: {
          read: mealDate,
          create: mealDate,
          update: mealDate.optional(),
        },
      },
      {
        key: "name",
        kind: "text",
        nullable: true,
        control: { kind: "text", placeholder: "Meal name (optional)" },
        display: { list: true, detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().optional(),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "sortOrder",
        kind: "number",
        nullable: true,
        control: { kind: "number", section: "ordering" },
        display: { list: true, detail: true },
        validation: {
          read: z.number().int().nullable(),
          create: z.number().int().nullable().optional(),
          update: z.number().int().nullable().optional(),
        },
      },
      {
        key: "mealType",
        kind: "enum",
        nullable: true,
        control: { kind: "select", placeholder: "Which meal of the day?" },
        display: { list: true, detail: true },
        validation: {
          read: mealTypeSchema.nullable(),
          create: mealTypeSchema
            .describe(
              "Which eating occasion of the day this is. Null when unslotted; the planning calendar orders a day's meals by it.",
            )
            .nullable()
            .optional(),
          update: mealTypeSchema
            .describe(
              "Which eating occasion of the day this is. Null when unslotted; the planning calendar orders a day's meals by it.",
            )
            .nullable()
            .optional(),
        },
      },
      {
        key: "mealKind",
        kind: "enum",
        control: { kind: "select" },
        display: { list: true, detail: true },
        validation: {
          read: mealKindSchema,
          create: mealKindSchema
            .describe(
              "How the meal is eaten. Defaults to `cooked`. Use `eating_out`/`takeout` for a placeholder meal that intentionally has no recipes; only `cooked` meals feed the shopping list.",
            )
            .optional(),
          update: mealKindSchema
            .describe(
              "How the meal is eaten. Defaults to `cooked`. Use `eating_out`/`takeout` for a placeholder meal that intentionally has no recipes; only `cooked` meals feed the shopping list.",
            )
            .optional(),
        },
      },
      {
        key: "recipes",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        // Rendered by the `composition` detail slot.
        validation: {
          read: z.array(mealRecipeOut),
          create: z.array(mealRecipeInput).optional(),
          update: null,
        },
      },
      {
        key: "pendingImageIds",
        kind: "identifier",
        readKey: null,
        reference: { entity: "image", multiple: true },
        validation: {
          read: null,
          create: z.array(imageShortcode).optional(),
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "removeImageIds",
        kind: "identifier",
        readKey: null,
        reference: { entity: "image", multiple: true },
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "imageOrder",
        kind: "text",
        readKey: null,
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "images",
        kind: "json",
        display: { list: true, standard: "image", columnId: "image" },
        validation: { read: z.array(imageOut), create: null, update: null },
      },
      {
        // `name?.trim() || date` — `name` is nullable, so this is the
        // canonical non-null title.
        key: "displayName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: mealShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "totals",
        kind: "json",
        // Rendered by the `nutrition` detail slot.
        validation: {
          read: mealTotals,
          create: null,
          update: null,
        },
      },
      {
        // The names of `recipes[].recipe`, so a generic row or facts list can
        // show what the meal is without decoding the composition.
        key: "recipeNames",
        kind: "text-array",
        label: "Recipes",
        display: { detail: true },
        validation: { read: z.array(z.string()), create: null, update: null },
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
    create: [
      "date",
      "name",
      "sortOrder",
      "mealType",
      "mealKind",
      "recipes",
      "pendingImageIds",
    ],
    update: [
      "date",
      "name",
      "sortOrder",
      "mealType",
      "mealKind",
      "pendingImageIds",
      "removeImageIds",
      "imageOrder",
    ],
    bulk: [],
    audit: [],
    sort: {
      fields: ["date", "name", "mealType", "createdAt", "updatedAt"],
      default: "date",
    },
    intents: {
      fields: {
        capture: ["date", "name", "mealType", "mealKind", "pendingImageIds"],
        full: [
          "date",
          "name",
          "mealType",
          "mealKind",
          "sortOrder",
          "pendingImageIds",
          "removeImageIds",
          "imageOrder",
        ],
        calendar: ["date", "name", "mealType", "mealKind"],
      },
      create: ["capture", "full"],
      update: ["full", "calendar"],
    },
    output: [
      "id",
      "date",
      "name",
      "sortOrder",
      "mealType",
      "mealKind",
      "recipes",
      "totals",
      "images",
      "displayName",
      "recipeNames",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/meal", export: "mealCreateInput" },
    update: { module: "@cubby/schemas/meal", export: "mealUpdateData" },
    output: { module: "@cubby/schemas/meal", export: "mealOut" },
    list: { module: "@cubby/schemas/meal", export: "mealListItemOut" },
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
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/meal-classification",
          export: "mealTypeSchema",
        },
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
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/meal-classification",
          export: "mealKindSchema",
        },
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
        brandRef: { entity: "recipe" },
        urlOnly: true,
      },
      {
        columnId: "related:meal.foodProducts",
        field: "foodProductSearch",
        urlKey: "related-foodProduct",
        kind: "text",
        placeholder: "Search related food products...",
      },
      {
        columnId: "foodProductId",
        kind: "idMulti",
        placeholder: "Filter by related food products id...",
        urlOnly: true,
      },
      {
        columnId: "foodProductPresenceFilter",
        kind: "presence",
        placeholder: "Filter related food products presence...",
        urlOnly: true,
      },
      {
        columnId: "related:meal.foodIngredients",
        field: "foodIngredientSearch",
        urlKey: "related-foodIngredient",
        kind: "text",
        placeholder: "Search related food ingredients...",
      },
      {
        columnId: "foodIngredientId",
        kind: "idMulti",
        placeholder: "Filter by related food ingredients id...",
        urlOnly: true,
      },
      {
        columnId: "foodIngredientPresenceFilter",
        kind: "presence",
        placeholder: "Filter related food ingredients presence...",
        urlOnly: true,
      },
      {
        columnId: "related:meal.eaters",
        field: "eaterSearch",
        urlKey: "related-eater",
        kind: "text",
        placeholder: "Search related eaters...",
      },
      {
        columnId: "eaterId",
        kind: "idMulti",
        placeholder: "Filter by related eaters id...",
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
      sources: [
        {
          key: "served-portions",
          label: "Served portions",
          provenance: {
            kind: "local-path",
            steps: [
              { edge: "MealRecipePortion.mealId", direction: "incoming" },
              {
                edge: "MealRecipePortion.mealRecipeId",
                direction: "outgoing",
              },
              { edge: "MealRecipe.recipeId", direction: "outgoing" },
            ],
          },
          inverse: {
            steps: [
              { edge: "MealRecipe.recipeId", direction: "incoming" },
              {
                edge: "MealRecipePortion.mealRecipeId",
                direction: "incoming",
              },
              { edge: "MealRecipePortion.mealId", direction: "outgoing" },
            ],
          },
        },
      ],
    },
    {
      key: "food-products",
      label: "Food products",
      target: "product",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealFoodEntry.mealId", direction: "incoming" },
          { edge: "MealFoodEntry.productId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealFoodEntry.productId", direction: "incoming" },
          { edge: "MealFoodEntry.mealId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "food-ingredients",
      label: "Food ingredients",
      target: "ingredient",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealFoodEntry.mealId", direction: "incoming" },
          { edge: "MealFoodEntry.ingredientId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealFoodEntry.ingredientId", direction: "incoming" },
          { edge: "MealFoodEntry.mealId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "eaters",
      label: "Eaters",
      target: "ledgerParty",
      cardinality: "many",
      sourceKey: "food-entries",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealFoodEntry.mealId", direction: "incoming" },
          { edge: "MealFoodEntry.ledgerPartyId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealFoodEntry.ledgerPartyId", direction: "incoming" },
          { edge: "MealFoodEntry.mealId", direction: "outgoing" },
        ],
      },
      sources: [
        {
          key: "portions",
          label: "Served portions",
          provenance: {
            kind: "local-path",
            steps: [
              { edge: "MealRecipePortion.mealId", direction: "incoming" },
              {
                edge: "MealRecipePortion.ledgerPartyId",
                direction: "outgoing",
              },
            ],
          },
          inverse: {
            steps: [
              {
                edge: "MealRecipePortion.ledgerPartyId",
                direction: "incoming",
              },
              { edge: "MealRecipePortion.mealId", direction: "outgoing" },
            ],
          },
        },
      ],
    },
    {
      key: "images",
      label: "Images",
      target: "image",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealImage.mealId", direction: "incoming" },
          { edge: "MealImage.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealImage.imageId", direction: "incoming" },
          { edge: "MealImage.mealId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: {
      storage: "gallery",
      displaySources: [
        {
          relationPath: ["recipes"],
          priority: 1,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [{ kind: "self", routeId: "meal-self" }],
      routing: {
        candidateFields: ["name"],
        temporalFields: ["date"],
        lifecycleFilters: [],
        signals: { ocrFields: ["name"], classifierLabels: ["meal"] },
        abstention: { minimumScore: 0.74, minimumMargin: 0.14 },
      },
    },
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
