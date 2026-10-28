import { timestampField } from "./field-policy";
import { imageDescriptionInputs } from "./image-description-inputs";
import { imageAssociationStorage } from "./image-associations";
import { mealReadSchemas } from "../meal-fields";
import { mealChildren } from "../child-tables/meal.js";
import { defineEntity, defineEntityModel } from "./definition.js";
import { selectControlOptions } from "./select-control-options.js";
import { imageShortcode, mealShortcode } from "../identifier-fields.js";
import {
  mealKindSchema,
  mealTypeSchema,
  mealTypeValues,
} from "@cubby/schemas/meal-classification";
import {
  mealRecipeInput,
  rawMealRecipeOut,
  mealTotals,
} from "@cubby/schemas/meal-fields";
import { mealDate } from "@cubby/schemas/meal-shared";
import { imageOut } from "./field-primitives.js";
import { labelField } from "./label-field.js";
import { z } from "zod";
export const { definition, readSchemas } = defineEntityModel(
  {
    key: "meal",
    names: { singular: "Meal", plural: "Meals" },
    route: {
      listColumns: {
        module: "~/features/meal/list-columns",
        export: "mealListOverride",
      },
      basePath: "meals",
    },
    table: "Meal",
    children: mealChildren,
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
      icons: {
        phosphor: "CalendarDots",
        sfSymbol: "fork.knife.circle",
        emoji: "🍽️",
      },
      detail: {
        summary: [
          {
            kind: "fields",
            id: "when-occasion",
            title: "When & occasion",
            fields: ["date", "mealType"],
          },
          {
            kind: "records",
            id: "recipes",
            title: "Recipes",
            viewKey: "relation:recipes",
          },
          {
            kind: "records",
            id: "direct-products",
            title: "Direct Products",
            viewKey: "relation:food-products",
          },
          {
            kind: "records",
            id: "direct-ingredients",
            title: "Direct Ingredients",
            viewKey: "relation:food-ingredients",
          },
          {
            kind: "records",
            id: "people",
            title: "People",
            viewKey: "relation:eaters",
          },
          {
            kind: "fields",
            id: "nutrition",
            title: "Nutrition",
            fields: ["totals"],
          },
          {
            kind: "fields",
            id: "estimated-cost",
            title: "Estimated cost",
            fields: ["cost"],
          },
          {
            kind: "records",
            id: "evidence",
            title: "Evidence",
            viewKey: "relation:images",
          },
        ],

        activityRelations: [{ relation: "images", dateField: "capturedAt" }],
        omitRelations: {
          eaters: "The composition slot renders each eater's portions.",
          "food-ingredients":
            "The composition slot renders food entries with their amounts.",
          "food-products":
            "The composition slot renders food entries with their amounts.",
          recipes:
            "The composition slot renders served recipes with their portions.",
        },
        hero: { when: { field: "date", label: "Eaten" } },
        sections: [
          {
            kind: "fields",
            id: "overview",
            title: "Record",
            fields: ["date", "name", "sortOrder", "mealType", "mealKind"],
          },
          {
            kind: "fields",
            id: "coverage",
            title: "Coverage and summaries",
            fields: ["recipeNames", "createdAt", "updatedAt"],
          },
          {
            kind: "slot",
            id: "composition",
            title: "Recipes",
            explanationField: "recipes",
          },
          {
            kind: "slot",
            id: "nutrition",
            title: "Nutrition",
            explanationField: "totals",
          },
        ],
      },
      list: {
        savedViews: [
          {
            id: "empty-cooked",
            label: "No linked recipes",
            description: "Cooked meals with no recipe recorded",
            filters: [
              { id: "mealKind", value: ["cooked"] },
              { id: "related:meal.recipes", value: "none" },
            ],
            sort: [{ id: "date", desc: false }],
            // The Recipes column is defaultVisible:false, so reveal the signal this
            // view selects on.
            layout: {
              columnVisibility: { "related:meal.recipes": true },
            },
          },
        ],
        views: [
          {
            kind: "slot",
            id: "calendar",
            label: "Calendar",
            searchKeys: ["period", "calendarDate"],
          },
          {
            kind: "slot",
            id: "nutrition",
            label: "Nutrition",
            searchKeys: ["date"],
          },
          "table",
        ],
        links: [{ label: "Shopping list", path: "/meals/shopping-list" }],
      },
    },
    model: {
      fields: [
        {
          audit: false,
          key: "date",
          kind: "date",
          control: {
            kind: "date",
            initial: "today",
          },
          display: {
            columnGroup: "Meal",
            format: "plainDate",
            mobile: { slot: "subtitle", priority: 10 },
          },
          validation: {
            read: mealDate,
            create: mealDate,
            update: mealDate.optional(),
          },
        },
        {
          audit: false,
          key: "name",
          kind: "text",
          nullable: true,
          control: { kind: "text", placeholder: "Meal name (optional)" },
          display: {},
          validation: {
            read: z.string().nullable(),
            create: z.string().nullable().optional(),
            update: z.string().nullable().optional(),
          },
        },
        {
          audit: false,
          key: "sortOrder",
          kind: "number",
          nullable: true,
          control: { kind: "number" },
          display: { columnGroup: "Meal" },
          validation: {
            read: z.number().int().nullable(),
            create: z.number().int().nullable().optional(),
            update: z.number().int().nullable().optional(),
          },
        },
        {
          audit: false,
          key: "mealType",
          kind: "enum",
          nullable: true,
          control: {
            kind: "select",
            placeholder: "Which meal of the day?",
            options: selectControlOptions.mealType,
            suggest: {
              basis: ["name"],
              rules: [
                `You are a meal-planning classification assistant. Given a meal name, determine which eating occasion of the day it is.

Rules:
1. Use the name's timing and dish cues (e.g., "pancakes" suggests breakfast, "birthday cake" suggests dessert).
2. Salads, sandwiches, and wraps suggest "lunch" when there is no stronger timing or dish cue.
3. When the name gives no timing or dish cue, prefer "dinner" — the most common unslotted meal.`,
              ],
            },
          },
          display: {
            columnGroup: "Meal",
            mobile: { slot: "meta", priority: 30 },
          },
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
          audit: false,
          key: "mealKind",
          kind: "enum",
          control: {
            kind: "select",
            options: selectControlOptions.mealKind,
            suggest: {
              basis: ["name"],
              rules: [
                `You are a meal-planning classification assistant. Given a meal name, determine how the meal is eaten.

Rules:
1. A named dish with no restaurant/delivery cue is "cooked".
2. "leftovers" only when the name says so explicitly.
3. Restaurant or delivery-service names indicate "eating_out" or "takeout" respectively.`,
              ],
            },
            // The storage default is a DB literal, so the create schema stays
            // optional with no Zod default to read.
            initial: { value: "cooked" },
          },
          display: {
            columnGroup: "Meal",
            width: "sm",
            mobile: { slot: "meta", priority: 40 },
          },
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
          audit: false,
          key: "recipes",
          kind: "json",
          control: { kind: "specialized", renderer: "structured-field" },
          display: {
            columnGroup: "Food",
            detail: false,
            labelPath: "recipes[].recipe.name",
            renderer: { list: "recipe-links" },
          },
          provenance: {
            kind: "relation",
            sources: [{ entity: "recipe", relation: "recipes" }],
          },
          explanation: {
            ruleId: "meal.recipe-composition",
            description:
              "Meal composition is the current ordered set of recipe servings recorded for this meal.",
            readPath: "recipes",
            sourceDependencies: [{ path: "recipes", label: "Recipe servings" }],
          },
          // Rendered by the `composition` detail slot.
          validation: {
            read: z.array(rawMealRecipeOut),
            create: z.array(mealRecipeInput).optional(),
            update: null,
          },
        },
        {
          output: false,
          audit: false,
          key: "pendingImageIds",
          kind: "identifier",
          reference: { entity: "image", multiple: true },
          validation: {
            read: null,
            create: z.array(imageShortcode).optional(),
            update: z.array(imageShortcode).optional(),
          },
        },
        {
          output: false,
          audit: false,
          key: "removeImageIds",
          kind: "identifier",
          reference: { entity: "image", multiple: true },
          validation: {
            read: null,
            create: null,
            update: z.array(imageShortcode).optional(),
          },
        },
        {
          output: false,
          audit: false,
          key: "imageOrder",
          semanticRole: "attachment",
          kind: "text",
          validation: {
            read: null,
            create: null,
            update: z.array(imageShortcode).optional(),
          },
        },
        {
          key: "images",
          kind: "json",
          display: { detail: false, standard: "image" },
          provenance: {
            kind: "derived",
            sources: [{ entity: "image", relation: "images" }],
          },
          explanation: {
            ruleId: "meal.images",
            description:
              "Meal images are the current live Image attachments in canonical attachment order; list and summary surfaces use the same selected images through the display-image projection.",
            projections: {
              list: "displayImages",
              detail: "images",
              summary: "displayImages",
            },
            sourceDependencies: [
              { path: "displayImages", label: "Selected meal images" },
            ],
          },
          validation: { read: z.array(imageOut), create: null, update: null },
        },
        {
          // `name?.trim() || date` — `name` is nullable, so this is the
          // canonical non-null title.
          key: "displayName",
          kind: "text",
          display: { detail: false, list: false, width: "lg" },
          validation: { read: z.string(), create: null, update: null },
        },
        {
          display: { detail: false, list: false },
          key: "id",
          kind: "identifier",
          validation: {
            read: mealShortcode,
            create: null,
            update: null,
          },
        },
        {
          display: { detail: false, list: false },
          key: "totals",
          kind: "json",
          // Rendered by the `nutrition` detail slot.
          explanation: {
            ruleId: "meal.totals",
            description:
              "Meal totals combine the current recipe servings and their available cost and nutrition totals.",
            readPath: "totals",
            sourceDependencies: [{ path: "recipes", label: "Recipe servings" }],
          },
          validation: {
            read: mealTotals,
            create: null,
            update: null,
          },
        },
        // Flat preview projections of `totals` (`totalsPreview`): a partial
        // estimate shows what is known, anything else reads as absent.
        {
          key: "cost",
          kind: "number",
          nullable: true,
          display: {
            detail: false,
            list: false,
            preview: true,
            format: "currency",
          },
          validation: {
            read: z
              .number()
              .nullable()
              .default(null)
              .describe("Known cost of the totals, in dollars"),
            create: null,
            update: null,
          },
        },
        {
          key: "calories",
          kind: "number",
          nullable: true,
          display: { detail: false, list: false, preview: true },
          validation: {
            read: z
              .number()
              .nullable()
              .default(null)
              .describe("Known kilocalories of the totals"),
            create: null,
            update: null,
          },
        },
        {
          output: false,
          key: "costTotal",
          kind: "json",
          nullable: true,
          labelOverride: "Cost",
          // Not sortable: a read-time rollup of `recipe.totals x scale` through
          // the estimate engine, which a SQL ORDER BY cannot reproduce for
          // partial/pending/unavailable results. The server composes the text.
          display: {
            columnGroup: "Food",
            columnIdOverride: "cost",
            labelPath: "costTotalLabel",
            width: "xs",
            mobile: { slot: "trailing", priority: 10 },
          },
          provenance: {
            kind: "derived",
            sources: [{ entity: "recipe", relation: "recipes" }],
          },
          explanation: {
            ruleId: "meal.cost-total",
            description:
              "Meal cost combines the current serving count with each recipe's available computed cost range.",
            resolver: "recipeTotals",
            projections: {
              list: "totals.cost",
              summary: "totals.cost",
            },
            sourceDependencies: [
              { path: "recipes", label: "Recipe servings" },
              { path: "totals.cost", label: "Computed meal cost" },
            ],
          },
        },
        { ...labelField("costTotalLabel", "Meal cost total"), output: false },
        {
          // The names of `recipes[].recipe`, so a generic row or facts list can
          // show what the meal is without decoding the composition.
          key: "recipeNames",
          kind: "text-array",
          display: { list: false },
          provenance: {
            kind: "derived",
            sources: [{ entity: "recipe", relation: "recipes" }],
          },
          explanation: {
            ruleId: "meal.recipe-names",
            description:
              "Recipe names are projected from the meal's current recipe composition.",
            readPath: "recipeNames",
            sourceDependencies: [
              { path: "recipes", label: "Recipe composition" },
            ],
          },
          validation: { read: z.array(z.string()), create: null, update: null },
        },
        timestampField("createdAt"),
        timestampField("updatedAt"),
        { output: false, key: "shortcode", kind: "text" },
        { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
      ],
      storage: [
        {
          key: "id",
          specialized: "primary-key:MealId",
        },
        { key: "shortcode", specialized: "shortcode" },
        "date",
        "name",
        "sortOrder",
        { key: "mealType", specialized: "enum:mealType" },
        {
          key: "mealKind",
          defaultValue: "'cooked'",
          specialized: "enum:mealKind",
        },
        { key: "createdAt" },
        { key: "updatedAt", specialized: "updated-at" },
        "deletedAt",
      ],

      // Slot order (`mealTypeValues` is clock order), not slug order.
      derived: {
        mealType: { type: "enum", options: [...mealTypeValues] },
        // A live recipe whose priced ingredients are incomplete.
        recipeCostCoverage: { type: "boolean" },
      },
      sort: {
        fields: ["date", "name", "mealType", "createdAt", "updatedAt"],
      },
      intents: {
        fields: {
          // `recipes` is create-only (an existing meal's recipes change through the composition
          // workflow), so it joins the create-only `capture` intent, not `full`.
          capture: [
            "date",
            "name",
            "mealType",
            "mealKind",
            "recipes",
            "pendingImageIds",
          ],
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
    },
    fields: {
      embedded: [
        {
          path: ["images"],
          entity: "image",
          projections: [
            "output",
            "list",
            "detail",
            "mcpOutput",
            "mcpList",
            "mcpDetail",
          ],
        },
        {
          path: ["recipes", "recipe"],
          entity: "recipe",
          projections: [
            "output",
            "list",
            "detail",
            "mcpOutput",
            "mcpList",
            "mcpDetail",
          ],
        },
      ],

      mcpOutput: {
        module: "@cubby/schemas/meal-raw-read",
        export: "rawMealMcpOutput",
      },
      mcpList: {
        module: "@cubby/schemas/meal-raw-read",
        export: "rawMealMcpList",
      },
      mcpDetail: {
        module: "@cubby/schemas/meal-raw-read",
        export: "rawMealMcpDetail",
      },
    },
    storage: {
      indexes: [
        {
          name: "Meal_date_active_idx",
          on: ["date"],
          where: "{deletedAt} IS NULL",
        },
      ],
      relations: {
        recipes: { many: "mealRecipe" },
        recipePortions: { many: "mealRecipePortion" },
        foodEntries: { many: "mealFoodEntry" },
        images: { many: "entityAttachment" },
      },
    },
    filters: {
      audit: true,
      schema: { module: "@cubby/schemas/meal", export: "mealFilterFields" },
      descriptors: [
        {
          columnId: "date",
          urlKey: "mealDate",
          kind: "range",
          wire: { kind: "range", from: "from", to: "to" },
          deriveSchema: true,
          stored: true,
          placeholder: "Filter by meal date...",
        },
        {
          columnId: "mealType",
          kind: "multiselect",
          placeholder: "Filter by meal type...",
          deriveSchema: true,
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
        },
        {
          columnId: "mealKind",
          kind: "multiselect",
          placeholder: "Filter by kind...",
          deriveSchema: true,
          schemaRef: {
            module: "@cubby/schemas/meal-classification",
            export: "mealKindSchema",
          },
          options: [
            { value: "cooked", label: "Cooked", color: "var(--slate)" },
            { value: "leftovers", label: "Leftovers", color: "var(--slate)" },
            {
              value: "eating_out",
              label: "Eating out",
              color: "var(--primary)",
            },
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
          kind: "boolean",
          placeholder: "Filter recipe cost coverage...",
          options: [{ value: "true", label: "Understated" }],
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
          brandRef: { entity: "product" },
        },
        {
          columnId: "foodProductPresenceFilter",
          kind: "presence",
          placeholder: "Filter related food products presence...",
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
          brandRef: { entity: "ingredient" },
        },
        {
          columnId: "foodIngredientPresenceFilter",
          kind: "presence",
          placeholder: "Filter related food ingredients presence...",
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
          brandRef: { entity: "ledgerParty" },
          currentMember: true,
        },
        {
          columnId: "eaterPresenceFilter",
          kind: "presence",
          placeholder: "Filter related eaters presence...",
        },
      ],
    },

    search: {
      mode: "semantic",
      inputs: [
        ...imageDescriptionInputs("meal"),

        { table: "MealRecipe", match: { mealId: "id" } },
        {
          table: "Recipe",
          match: { id: "id" },
          columns: ["name", "totals", "deletedAt"],
          path: [{ table: "MealRecipe", from: "recipeId", to: "mealId" }],
        },
      ],
    },
    capabilities: {
      images: {
        storage: imageAssociationStorage.shape.meal.value,
        displaySources: [
          {
            relationPath: ["recipes"],
          },
        ],
        ingress: [
          { kind: "self", routeId: "meal-self" },
          {
            kind: "createSelf",
            routeId: "meal-new",
            enabled: true,
            bindings: [{ field: "date", from: "capture-date" }],
          },
        ],
        routing: {
          category: "food",
          candidateFields: ["name"],
          temporalFields: ["date"],
          lifecycleFilters: [],
          signals: { ocrFields: ["name"], classifierLabels: ["food"] },
          abstention: { minimumScore: 0.74, minimumMargin: 0.14 },
        },
      },
      delete: { mode: "soft", bulk: true },
      merge: false,
      dataQuality: {
        // Rows the stored evaluator reads beyond its own row (ADR 0021).
        inputs: [
          {
            table: "MealRecipe",
            match: { mealId: "id" },
            columns: ["deletedAt", "recipeId"],
            path: [{ table: "Meal", from: "id", to: "id" }],
          },
          {
            table: "Recipe",
            match: { id: "id" },
            columns: ["deletedAt", "id"],
            path: [
              { table: "MealRecipe", from: "recipeId", to: "mealId" },
              { table: "Meal", from: "id", to: "id" },
            ],
          },
          {
            table: "EntityAttachment",
            match: { entityId: "id" },
            columns: ["deletedAt", "imageId", "purpose", "role"],
            path: [
              { table: "Recipe", from: "id", to: "id" },
              { table: "MealRecipe", from: "recipeId", to: "mealId" },
              { table: "Meal", from: "id", to: "id" },
            ],
          },
          {
            table: "Image",
            match: { id: "id" },
            columns: [
              "deletedAt",
              "renderStatus",
              "storageStatus",
              "detectedContentType",
            ],
            path: [
              { table: "EntityAttachment", from: "imageId", to: "entityId" },
              { table: "Recipe", from: "id", to: "id" },
              { table: "MealRecipe", from: "recipeId", to: "mealId" },
              { table: "Meal", from: "id", to: "id" },
            ],
          },
          { table: "MealRecipe", match: { mealId: "id" } },
          {
            table: "Recipe",
            match: { id: "id" },
            columns: ["name", "totals", "deletedAt"],
            path: [{ table: "MealRecipe", from: "recipeId", to: "mealId" }],
          },
          {
            table: "MealFoodEntry",
            match: { mealId: "id" },
            columns: ["deletedAt"],
          },
          { table: "MealRecipe", match: { mealId: "id" } },
        ],
        checks: [
          {
            id: "meal_recipe_cost_incomplete",
            satisfiedLabel: "Recipe costs complete",
            placement: { section: "composition" },
            facet: "integrity",
            kind: "defect",
            weight: 1,
            scoring: "unscored",
            exceptions: "forbidden",
            label: "Incomplete recipe cost",
            message:
              "A live linked recipe has incomplete priced ingredient coverage.",
          },
          {
            id: "meal_contents",
            satisfiedLabel: "Contents recorded",
            placement: { section: "composition" },
            facet: "content",
            weight: 3,
            scoreCap: 69,
            label: "Contents",
            message:
              "No live recipes or food entries are recorded for this cooked meal.",
          },
        ],
      },
    },
    extensions: {
      ports: {
        repository: {
          module: "~/server/domains/meal/repo/repository",
          export: "mealRepository",
        },
        search: "document",
      },
    },
  },
  mealReadSchemas,
);

export default defineEntity(
  definition,
  (r) => [
    r
      .path("recipe", "many", [
        { edge: "MealRecipe.mealId", direction: "incoming" },
        { edge: "MealRecipe.recipeId", direction: "outgoing" },
      ])
      .named("recipes", "Recipes", {
        view: { columnGroup: "Food", inverseKey: "recipe.meals" },
        sources: [
          r
            .path("recipe", "many", [
              { edge: "MealRecipePortion.mealId", direction: "incoming" },
              {
                edge: "MealRecipePortion.mealRecipeId",
                direction: "outgoing",
              },
              { edge: "MealRecipe.recipeId", direction: "outgoing" },
            ])
            .source("served-portions", "Served portions"),
        ],
      }),
    r
      .path("product", "many", [
        { edge: "MealFoodEntry.mealId", direction: "incoming" },
        { edge: "MealFoodEntry.productId", direction: "outgoing" },
      ])
      .named("food-products", "Food products", {
        view: {
          key: "foodProducts",
          columnGroup: "Food",
          filterPrefix: "foodProduct",
          inverseKey: "product.meals",
        },
      }),
    r
      .path("ingredient", "many", [
        { edge: "MealFoodEntry.mealId", direction: "incoming" },
        { edge: "MealFoodEntry.ingredientId", direction: "outgoing" },
      ])
      .named("food-ingredients", "Food ingredients", {
        view: {
          key: "foodIngredients",
          columnGroup: "Food",
          filterPrefix: "foodIngredient",
          inverseKey: "ingredient.meals",
        },
      }),
    r
      .path("ledgerParty", "many", [
        { edge: "MealFoodEntry.mealId", direction: "incoming" },
        { edge: "MealFoodEntry.ledgerPartyId", direction: "outgoing" },
      ])
      .named("eaters", "Eaters", {
        view: {
          columnGroup: "People",
          filterPrefix: "eater",
          inverseKey: "ledgerParty.meals",
        },
        sourceKey: "food-entries",
        sources: [
          r
            .path("ledgerParty", "many", [
              { edge: "MealRecipePortion.mealId", direction: "incoming" },
              {
                edge: "MealRecipePortion.ledgerPartyId",
                direction: "outgoing",
              },
            ])
            .source("portions", "Served portions"),
        ],
      }),
    r
      .path("image", "many", [
        { edge: "EntityAttachment.entityId", direction: "incoming" },
        { edge: "EntityAttachment.imageId", direction: "outgoing" },
      ])
      .named("images", "Images"),
  ],
  readSchemas,
);
