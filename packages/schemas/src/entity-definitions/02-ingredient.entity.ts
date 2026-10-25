import { ingredientReadSchemas } from "../ingredient-read-fields";
import { defineEntity } from "./definition.js";
import { ingredientShortcode, productShortcode } from "../identifier-fields.js";
import { ingredientApplicabilityKey } from "../codec.js";
import { imageOut } from "./field-primitives.js";
import { z } from "zod";

export default defineEntity(
  {
    key: "ingredient",
    names: { singular: "Ingredient", plural: "Ingredients" },
    route: {
      listColumns: {
        module: "~/features/ingredient/list-columns",
        export: "ingredientListOverride",
      },
      basePath: "ingredients",
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
      icons: { phosphor: "Carrot", sfSymbol: "leaf", emoji: "🥕" },
      detail: {
        summary: [
          {
            kind: "records",
            id: "products",
            title: "Products",
            viewKey: "relation:products",
          },
          {
            kind: "records",
            id: "stocked-locations",
            title: "Stocked locations",
            viewKey: "locations",
          },
          {
            kind: "records",
            id: "recipe-uses",
            title: "Recipe uses",
            viewKey: "relation:recipes",
          },
          {
            kind: "fields",
            id: "nutrition-source",
            title: "Nutrition source",
            fields: ["nutritionSourceProductId"],
          },
          {
            kind: "report",
            id: "bought-from",
            title: "Bought from",
            slot: "ingredient.sellers",
          },
          {
            kind: "records",
            id: "meals",
            title: "Meals",
            viewKey: "relation:meals",
          },
          {
            kind: "fields",
            id: "cooking-role",
            title: "Cooking role",
            fields: ["usuallyOnHand"],
          },
          {
            kind: "records",
            id: "growing-source",
            title: "Growing source",
            viewKey: "relation:plants",
          },
        ],

        activityRelations: [{ relation: "meals", dateField: "date" }],
        omitRelations: {
          eaters:
            "Who ate it is per-portion meal data; the Meals table on this page shows each meal and its eaters.",
        },
        additionalSections: [
          { kind: "slot", id: "recipe-usages", title: "Recipe lines" },
          { kind: "slot", id: "nutrition-product", title: "Nutrition" },
        ],
      },
      list: {
        // A recipe's own ingredient rows (a recipe used as an ingredient) are
        // never listed or counted.
        scope: ["recipeId"],
        savedViews: [
          {
            id: "needs-a-product",
            label: "Needs a product",
            description:
              "Used by one of your own recipes, with nothing to cost it",
            // `ingredient_product`'s own `expected` is "not a sub-recipe, used by
            // one of the household's own recipes" (checks/ingredient.ts) — the
            // cookbook import supplies the overwhelming majority of ingredient
            // usages on this database, and counting them turns ~24 actionable rows
            // into ~1000. A cookbook recipe you can't cost is not a gap in your own
            // data.
            filters: [{ id: "dataGaps", value: ["ingredient_product"] }],
            problem: {
              key: "ingredientsWithoutProduct",
              title: "Ingredients with no product",
              description:
                "Used by a recipe of your own but linked to no product, so nothing can price or convert them. Cookbook-only ingredients are excluded — costing someone else's book isn't the goal.",
              emptyMessage: "Every ingredient your recipes use has a product.",
            },
            layout: {
              columnVisibility: { ownRecipes: true },
            },
          },
          {
            id: "unused-with-product",
            label: "Unused (has product)",
            description: "Used in no recipe, but still linked to a product",
            // `appearsInRecipes: none` already excludes recipe-as-ingredient pointer
            // rows — `ingredientList` applies `isNull(ingredient.recipeId)`
            // unconditionally — so a hit really is an ingredient no live recipe
            // references, which is what the detector's own NOT EXISTS meant.
            filters: [
              { id: "appearsInRecipes", value: "none" },
              { id: "product", value: "has" },
            ],
            problem: {
              key: "unusedIngredientsWithProduct",
              title: "Unused ingredients linked to a product",
              description:
                "Ingredients used in no recipe but still linked to a product. Deleting removes the ingredient and its product(s) — skipped if a product still has inventory.",
              emptyMessage: "No unused product-linked ingredients.",
            },
          },
          {
            id: "unused-no-product",
            label: "Unused",
            description: "Used in no recipe and linked to no product",
            filters: [
              { id: "appearsInRecipes", value: "none" },
              { id: "product", value: "none" },
            ],
            problem: {
              key: "unusedIngredientsWithoutProduct",
              title: "Unused ingredients",
              description:
                "Ingredients used in no recipe and linked to no product — safe to delete.",
              emptyMessage: "No unused ingredients.",
            },
          },
        ],
        read: {
          relations: ["product", "appearsInRecipes"],
          derived: ["ownRecipeCount"],
          media: ["displayImages"],
          quality: ["dataQuality"],
        },
        links: [
          { label: "Equivalences", path: "/ingredients/equivalences" },
          { label: "Workbench", path: "/ingredients/workbench" },
        ],
      },
    },
    model: {
      fields: [
        {
          key: "nutritionSourceProductId",
          labelOverride: "Nutrition source Product",
          kind: "identifier",
          readKeyOverride: null,
          nullable: true,
          reference: { entity: "product" },
          display: {
            readPath: "nutritionProduct.productId",
            detailLabelPath: "nutritionProduct.name",
          },
          validation: {
            read: productShortcode.nullable(),
            create: null,
            update: null,
          },
        },
        {
          key: "name",
          kind: "text",
          control: { kind: "text" },
          display: { width: "lg" },
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
          collection: { key: "value" },
          control: { kind: "specialized", renderer: "tag-list" },
          display: {
            columnGroup: "Ingredient",
            width: "md",
            mobile: { slot: "subtitle", priority: 20 },
          },
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
          display: { detail: false, list: false },
          key: "naKinds",
          labelOverride: "Not applicable",
          description:
            "Measurement kinds or nutrient keys intentionally excluded from enrichment. Nutrient opt-outs remain unavailable rather than zero.",
          kind: "text-array",
          collection: { key: "value" },
          control: { kind: "specialized", renderer: "tag-list" },
          validation: {
            read: z.array(ingredientApplicabilityKey),
            create: z.array(ingredientApplicabilityKey).optional().default([]),
            update: z.array(ingredientApplicabilityKey).optional(),
          },
        },
        {
          key: "usuallyOnHand",
          kind: "boolean",
          description:
            "Assume I have enough for recipe planning. Recorded inventory stays separate.",
          control: { kind: "checkbox" },
          display: {
            columnGroup: "Ingredient",
            columnLabel: "On hand",
            mobile: { slot: "meta", priority: 25 },
          },
          validation: {
            read: z.boolean(),
            create: z.boolean().optional().default(false),
            update: z.boolean().optional(),
          },
        },
        {
          display: { detail: false, list: false },
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
          display: { list: false },
          validation: {
            read: z.date(),
            create: null,
            update: null,
          },
        },
        {
          key: "updatedAt",
          kind: "timestamp",
          display: { list: false },
          validation: {
            read: z.date(),
            create: null,
            update: null,
          },
        },
        {
          key: "images",
          kind: "json",
          display: { standard: "image" },
          provenance: {
            kind: "derived",
            sources: [{ entity: "product", relation: "products" }],
          },
          validation: { read: z.array(imageOut), create: null, update: null },
        },
        { key: "shortcode", kind: "text" },
        {
          key: "deletedAt",
          kind: "timestamp",
          nullable: true,
        },
        {
          display: { detail: false },
          key: "recipeId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "recipe" },
        },
      ],
      storage: [
        {
          key: "id",
          specialized: "primary-key:IngredientId",
        },
        { key: "shortcode", specialized: "shortcode" },
        "name",
        {
          key: "aliases",
          defaultValue: "'{}'::text[]",
          specialized: "text-array",
        },
        {
          key: "naKinds",
          defaultValue: "'{}'::text[]",
          specialized: "text-array",
        },
        { key: "usuallyOnHand", defaultValue: false },
        { key: "createdAt" },
        { key: "updatedAt", specialized: "updated-at" },
        "deletedAt",
        { key: "recipeId", reference: "recipe" },
      ],
      create: ["name", "aliases", "naKinds", "usuallyOnHand"],
      update: ["naKinds", "usuallyOnHand", "name", "aliases"],
      audit: ["name", "aliases", "naKinds", "usuallyOnHand"],
      derived: {
        appearsInRecipes: { type: "number" },
        // The number of live Products mapped to the ingredient.
        product: { type: "number" },
        // A live Product is mapped to the ingredient.
        hasProduct: { type: "boolean" },
        // Used by a live recipe.
        inRecipes: { type: "boolean" },
        // Used by a live recipe of your own (not a cookbook import).
        ownRecipes: { type: "boolean" },
        // Used by a live recipe with no live Product whose conversion coverage
        // is complete.
        mappingGap: { type: "boolean" },
      },
      sort: {
        fields: [
          "createdAt",
          "updatedAt",
          "name",
          "appearsInRecipes",
          "product",
        ],
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
    storage: {
      indexes: [
        // Case-insensitive uniqueness must match the lower(name) matcher to
        // prevent concurrent duplicate ingredients.
        {
          name: "Ingredient_name_key",
          on: [{ sql: "lower({name})" }],
          unique: true,
          where: "{deletedAt} IS NULL AND {recipeId} IS NULL",
        },
        { on: ["recipeId"], unique: true, where: "{deletedAt} IS NULL" },
        { on: ["createdAt"] },
        { trigram: "name" },
        {
          name: "Ingredient_name_active_idx",
          on: ["name"],
          where: "{deletedAt} IS NULL",
        },
      ],
      relations: {
        recipe: "recipeId",
        recipeSectionIngredient: { many: "recipeSectionIngredient" },
        product: { many: "product", relationName: "ProductIngredient" },
        plants: { many: "plant" },
        mealFoodEntries: { many: "mealFoodEntry" },
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
          anyOf: ["name", "aliases"],
          schemaDescription: "Filter by ingredient name or alias (substring)",
        },
        {
          columnId: "product",
          field: "productPresenceFilter",
          kind: "presence",
          derived: "hasProduct",
          placeholder: "Filter product...",
          options: [
            { value: "has", label: "Has product", meta: true },
            { value: "none", label: "(none)", meta: true },
          ],
        },
        {
          columnId: "mappingGap",
          field: "mappingGap",
          kind: "boolean",
          placeholder: "Filter product mapping...",
          options: [{ value: "true", label: "Needs product mapping" }],
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
          derived: "inRecipes",
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
        },
        {
          columnId: "mealPresenceFilter",
          kind: "presence",
          placeholder: "Filter related meals presence...",
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
          currentMember: true,
        },
        {
          columnId: "eaterPresenceFilter",
          kind: "presence",
          placeholder: "Filter related eaters presence...",
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
    search: "semantic",
    capabilities: {
      images: {
        storage: false,
        displaySourceOverrides: [
          {
            relationPath: ["products"],
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
      delete: { mode: "soft", bulk: true },
      merge: true,
      // Standalone ingredients only: a recipe's own ingredient rows (`recipeId`
      // set) are never a resolve target.
      resolve: {
        match: ["name", "aliases"],
        createMissing: true,
        scope: ["recipeId"],
      },
      dataQuality: {
        // Rows the stored evaluator reads beyond its own row (ADR 0021).
        inputs: [{ table: "Product", match: { ingredientId: "id" } }],
        checks: [
          {
            id: "ingredient_product",
            satisfiedLabel: "Product linked",
            placement: { section: "nutrition-product" },
            facet: "linkage",
            weight: 2,
            label: "Product link",
            message: "No product is linked to this ingredient.",
            coverage: "ingredientsWithoutProduct",
          },
          {
            id: "ingredient_recipe_deleted",
            satisfiedLabel: "Sub-recipe available",
            placement: { section: "recipe-usages" },
            facet: "integrity",
            kind: "defect",
            weight: 3,
            scoreCap: 49,
            label: "Deleted sub-recipe",
            message: "This sub-recipe ingredient's recipe is deleted.",
          },
        ],
      },
    },
    extensions: {
      ports: {
        repository: {
          module: "~/server/domains/ingredient/repo/repository",
          export: "ingredientRepository",
        },
        search: "document",
      },
    },
  },
  ingredientReadSchemas,
);
