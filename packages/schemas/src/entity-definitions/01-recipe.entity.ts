import { defineEntity } from "./definition.js";
import { imageShortcode, recipeShortcode } from "../identifier-fields.js";
import { imageOut } from "./field-primitives.js";
import { recipeSectionsInput, recipeSectionsOut } from "../recipe-fields.js";
import {
  recipeMeta,
  recipeNotes,
  recipeServings,
  recipeSource,
  recipeTags,
  recipeTotals,
  recipeYieldSchema,
} from "@cubby/schemas/recipe-shared";
import { z } from "zod";
export default defineEntity({
  key: "recipe",
  names: { singular: "Recipe", plural: "Recipes" },
  route: { basePath: "recipes", createOverride: "page", detailOverride: null },
  table: "Recipe",
  identifiers: { brand: "RecipeId", shortcode: "RCP-" },
  presentation: {
    titleField: "name",
    domain: "cook",
    description: "Recipes, their sections, and composition.",
    emptyState: {
      title: "Your recipe book awaits",
      description:
        "Start a collection of recipes you love. Import one from a URL, or write it from scratch.",
      actionLabel: "Create Recipe",
    },
    icons: { lucide: "ChefHat", sfSymbol: "fork.knife", emoji: "🍳" },
    detail: {
      hero: { imagesOverride: true },
      sectionOverrides: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          placement: "supporting",
          fields: [
            "name",
            "servings",
            "yield",
            "meta",
            "tags",
            "source",
            "forkedFromRecipeId",
            "notes",
            "createdAt",
            "updatedAt",
          ],
        },
        {
          kind: "fields",
          id: "contents",
          title: "Recipe",
          fields: ["sections", "totals"],
        },
        { kind: "slot", id: "workflow", placement: "full" },
        {
          kind: "relation",
          id: "meals",
          title: "Meals",
          relation: "meals",
          filter: { descriptor: "recipeId" },
          columns: ["date", "name", "mealType"],
          sort: { field: "date", direction: "desc" },
        },
      ],
    },
    list: {
      links: [
        { label: "Compare", path: "/recipes/compare" },
        { label: "Import", path: "/recipes/import" },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text", section: "identity" },
        display: { list: true, detail: true, standard: "name" },
        validation: {
          read: z.string(),
          create: z.string().trim().min(1, "Recipe name is required"),
          update: z
            .string()
            .trim()
            .min(1, "Recipe name is required")
            .optional(),
        },
      },
      {
        key: "meta",
        kind: "json",
        nullable: true,
        control: { kind: "specialized", renderer: "structured-field" },
        display: { detail: true, renderer: { detail: "recipe-meta" } },
        validation: {
          read: recipeMeta,
          create: recipeMeta,
          update: recipeMeta.optional(),
        },
      },
      {
        key: "yield",
        kind: "json",
        nullable: true,
        control: { kind: "specialized", renderer: "structured-field" },
        display: { detail: true, renderer: { detail: "recipe-yield" } },
        validation: {
          read: recipeYieldSchema.nullable().optional(),
          create: recipeYieldSchema.nullable().optional(),
          update: recipeYieldSchema.nullable().optional(),
        },
      },
      {
        key: "servings",
        kind: "number",
        nullable: true,
        // The rendered column keeps its existing "yield" id (structured
        // yield falls back to servings — see recipelist.tsx) and its
        // existing "Yield" header, distinct from this field's own key.
        label: "Yield",
        control: { kind: "number", section: "servings" },
        display: {
          list: true,
          detail: true,
          width: "xs",
          mobile: { slot: "trailing", priority: 5, interactive: true },
          columnId: "yield",
          listOrder: 1,
        },
        validation: {
          read: recipeServings.nullable().optional(),
          create: recipeServings.nullable().optional(),
          update: recipeServings.nullable().optional(),
        },
      },
      {
        key: "tags",
        kind: "text-array",
        nullable: true,
        control: { kind: "specialized", renderer: "tag-list" },
        display: { list: true, detail: true, listOrder: 0 },
        validation: {
          read: recipeTags.nullable().optional(),
          create: recipeTags.nullable().optional(),
          update: recipeTags.nullable().optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        description: "Optional. Supports Markdown.",
        control: { kind: "textarea" },
        // Hidden by default (`listHidden`) but toggleable via the View menu —
        // never actually shown by default before this field went through
        // `createEntityDisplayColumns`.
        display: { list: true, detail: true, listHidden: true },
        validation: {
          read: recipeNotes.nullable().optional(),
          create: recipeNotes.nullable().optional(),
          update: recipeNotes.nullable().optional(),
        },
      },
      {
        key: "costTotal",
        kind: "number",
        nullable: true,
        label: "Cost",
        // Computed from `totals.cost` at read time — no column of its own
        // in the list row, so column building requires the override
        // recipelist.tsx supplies.
        readKey: null,
        display: { list: true, listOrder: 2 },
        provenance: { kind: "derived", sources: [{ entity: "recipe" }] },
        explanation: {
          ruleId: "recipe.cost-total",
          description:
            "Recipe cost is the stored costing result for the current recipe inputs, including its range and coverage state.",
          resolver: "recipeTotals",
          projections: {
            list: "totals.cost",
            summary: "totals.cost",
          },
          sourceDependencies: [
            { path: "totals.cost", label: "Computed cost result" },
          ],
        },
      },
      {
        key: "caloriesTotal",
        kind: "number",
        nullable: true,
        label: "Calories",
        // Computed from `totals.nutrition.kcal` at read time; see costTotal.
        readKey: null,
        display: { list: true, listOrder: 3 },
        provenance: { kind: "derived", sources: [{ entity: "recipe" }] },
        explanation: {
          ruleId: "recipe.calories-total",
          description:
            "Recipe calories are the stored nutrition result for the current recipe inputs, including its range and coverage state.",
          resolver: "recipeTotals",
          projections: {
            list: "totals.nutrition.kcal",
            summary: "totals.nutrition.kcal",
          },
          sourceDependencies: [
            { path: "totals.nutrition.kcal", label: "Computed calorie result" },
          ],
        },
      },
      {
        key: "meals",
        kind: "number",
        label: "Meals",
        // The list row carries this as `mealCount` (a live MealRecipe count,
        // not a stored column); `reference` marks it as relation-derived so
        // column building requires the override recipelist.tsx supplies.
        readKey: "mealCount",
        reference: { entity: "meal", multiple: true },
        display: { list: true, listOrder: 6 },
        explanation: {
          ruleId: "recipe.meal-count",
          description:
            "Meal count is the number of live meal-recipe links that currently include this recipe.",
          readPath: "mealCount",
        },
      },
      {
        key: "sections",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        display: { detail: true, renderer: { detail: "recipe-sections" } },
        provenance: {
          kind: "relation",
          sources: [{ label: "Recipe sections" }],
        },
        explanation: {
          ruleId: "recipe.sections",
          description:
            "Recipe contents are the current live sections and ingredient lines in their recorded order.",
          readPath: "sections",
          sourceDependencies: [
            { path: "sections", label: "Recipe sections and ingredient lines" },
          ],
        },
        validation: {
          read: recipeSectionsOut,
          create: recipeSectionsInput,
          update: recipeSectionsInput.optional(),
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
          read: null,
          create: z.array(imageShortcode).optional(),
          update: z.array(imageShortcode).optional(),
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
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "imageOrder",
        kind: "text",
        readKey: null,
        control: { kind: "specialized", renderer: "image-order" },
        provenance: {
          kind: "relation",
          sources: [{ entity: "image", relation: "images" }],
        },
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: recipeShortcode,
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
      {
        key: "source",
        // Object-valued (a discriminated union of book/website/other
        // sources) — not a text field. The list column always renders
        // through recipelist.tsx's override (cookbook link or external URL).
        kind: "json",
        nullable: true,
        display: {
          list: true,
          detail: true,
          listOrder: 5,
          renderer: { list: "recipe-source", detail: "recipe-source" },
        },
        provenance: { kind: "derived", sources: [{ label: "Recipe source" }] },
        explanation: {
          ruleId: "recipe.source",
          description:
            "The source display is normalized from the recipe's cookbook, website, or free-form source record.",
          readPath: "source",
          sourceDependencies: [
            { path: "source", label: "Normalized recipe source" },
          ],
        },
        validation: {
          read: recipeSource.nullable().optional(),
          create: null,
          update: null,
        },
      },
      {
        key: "totals",
        kind: "json",
        nullable: true,
        display: { detail: true, renderer: { detail: "recipe-totals" } },
        explanation: {
          ruleId: "recipe.totals",
          description:
            "These cost and nutrition totals are the stored costing result exposed for the current recipe inputs.",
          resolver: "recipeTotals",
          readPath: "totals",
          sourceDependencies: [
            { path: "totals", label: "Computed recipe totals" },
          ],
        },
        validation: {
          read: recipeTotals.nullable().optional(),
          create: null,
          update: null,
        },
      },
      {
        key: "images",
        kind: "json",
        display: { list: true, standard: "image", columnId: "image" },
        provenance: {
          kind: "derived",
          sources: [{ entity: "image", relation: "images" }],
        },
        explanation: {
          ruleId: "recipe.images",
          description:
            "Recipe images are the current live Image attachments in canonical attachment order; list and summary surfaces use the same selected images through the display-image projection.",
          projections: {
            list: "displayImages",
            detail: "images",
            summary: "displayImages",
          },
          sourceDependencies: [
            { path: "displayImages", label: "Selected recipe images" },
          ],
        },
        validation: {
          read: z.array(imageOut),
          create: null,
          update: null,
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
        key: "forkedFromRecipeId",
        kind: "identifier",
        nullable: true,
        label: "Forked from",
        reference: { entity: "recipe" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true },
        validation: {
          read: recipeShortcode.nullable(),
          create: recipeShortcode.nullable().optional(),
          update: recipeShortcode.nullable().optional(),
        },
      },
      // Derived, read-only: the forked-from recipe's name, joined at read time
      // (same "<ref>Id" + "<ref>Name" pairing as Task.parentTaskId/parentTaskName)
      // so the UI can render a real link label instead of a bare shortcode.
      {
        key: "forkedFromRecipeName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "totalsComputedAt",
        kind: "timestamp",
        nullable: true,
        readKey: null,
      },
      { key: "activeMinutes", kind: "number", nullable: true, readKey: null },
      {
        key: "totalMinutes",
        kind: "number",
        nullable: true,
        label: "Time",
        // No row scalar of its own — the list column prints the source's
        // own time prose (recipe.meta.times.total) when there is one, which
        // doesn't always imply a present totalMinutes count. Requires the
        // override recipelist.tsx supplies.
        readKey: null,
        display: { list: true, listOrder: 4 },
        explanation: {
          ruleId: "recipe.total-time",
          description:
            "The time cell shows the recipe source's time text together with its normalized total-minute value when available.",
          projections: { list: "meta.times", summary: "meta.times" },
          sourceDependencies: [
            { path: "meta.times", label: "Recipe time metadata" },
          ],
        },
      },
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
      { key: "forkedFromRecipeId", reference: "recipe" },
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
      "forkedFromRecipeId",
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
      "forkedFromRecipeId",
    ],
    bulk: [],
    audit: ["name", "forkedFromRecipeId"],
    sort: {
      fields: [
        "createdAt",
        "updatedAt",
        "name",
        "cookbook",
        "costTotal",
        "caloriesTotal",
        "source",
        "yield",
        "tags",
        "totalMinutes",
      ],
      computed: ["cookbook", "costTotal", "caloriesTotal"],
      groupable: ["name"],
    },
    intents: {
      fields: {
        capture: ["name"],
        full: [
          "name",
          "cookbookId",
          "tags",
          "notes",
          "sections",
          "forkedFromRecipeId",
        ],
        identity: ["name", "cookbookId", "tags"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
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
      "forkedFromRecipeId",
      "forkedFromRecipeName",
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
        stored: { columns: ["name", "notes"] },
      },
      {
        columnId: "tags",
        field: "tagFilters",
        kind: "multiselect",
        placeholder: "Filter by tag...",
        optionsKey: "tags",
        deriveSchema: true,
        stored: { array: true },
        nullable: { field: "tagsPresenceFilter", label: "tags" },
      },
      {
        columnId: "source",
        field: "cookbookId",
        kind: "idMulti",
        placeholder: "Filter by cookbook...",
        optionsKey: "cookbook",
        brandRef: { entity: "cookbook" },
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
        stored: true,
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
        brandRef: { entity: "ingredient" },
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
        brandRef: { entity: "meal" },
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
      key: "forkedFrom",
      label: "Forked from",
      target: "recipe",
      cardinality: "one",
      inverseOmit:
        "The recipe page is custom; a recipe's forks are reached from each fork's Forked from field.",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Recipe.forkedFromRecipeId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Recipe.forkedFromRecipeId", direction: "incoming" }],
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
          { edge: "EntityAttachment.subjectEntityId", direction: "incoming" },
          { edge: "EntityAttachment.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityAttachment.imageId", direction: "incoming" },
          { edge: "EntityAttachment.subjectEntityId", direction: "outgoing" },
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
      sources: [
        {
          key: "served-portions",
          label: "Served portions",
          provenance: {
            kind: "local-path",
            steps: [
              { edge: "MealRecipe.recipeId", direction: "incoming" },
              {
                edge: "MealRecipePortion.mealRecipeId",
                direction: "incoming",
              },
              { edge: "MealRecipePortion.mealId", direction: "outgoing" },
            ],
          },
          inverse: {
            steps: [
              { edge: "MealRecipePortion.mealId", direction: "incoming" },
              {
                edge: "MealRecipePortion.mealRecipeId",
                direction: "outgoing",
              },
              { edge: "MealRecipe.recipeId", direction: "outgoing" },
            ],
          },
        },
      ],
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: {
      storage: "gallery",
      displaySourceOverrides: [
        {
          relationPath: ["meals"],
          priority: 1,
          ordering: "newest",
          identityEvidence: false,
        },
      ],
      ingress: [
        { kind: "self", routeId: "recipe-self", choice: "primary" },
        {
          kind: "existingRelated",
          routeId: "recipe-meal",
          relationPath: ["meals"],
          choice: "alternate",
        },
        {
          kind: "createRelated",
          routeId: "recipe-new-meal",
          relationPath: ["meals"],
          choice: "alternate",
          bindings: [
            { field: "date", from: "capture-date" },
            {
              field: "recipes",
              from: "relation-items",
              item: { field: "recipeId", from: "source-id" },
            },
          ],
        },
        { kind: "createSelf", routeId: "recipe-new", enabled: true },
      ],
      routing: {
        category: "food",
        candidateFields: ["name"],
        temporalFields: [],
        lifecycleFilters: [],
        signals: { ocrFields: ["name"], classifierLabels: ["food"] },
        visualEvidence: [
          {
            relationPath: ["meals"],
            priority: 1,
            ordering: "newest",
          },
        ],
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
    dataQuality: {
      checks: [
        {
          id: "recipe_ingredients",
          facet: "content",
          weight: 2,
          label: "Ingredients",
          message: "No ingredient lines are recorded.",
        },
        {
          id: "recipe_instructions",
          facet: "content",
          weight: 2,
          label: "Instructions",
          message: "No written instructions are recorded.",
        },
        {
          id: "recipe_source",
          facet: "provenance",
          weight: 1,
          label: "Source",
          message: "No recipe source is recorded.",
        },
      ],
    },
  },
  extensions: {
    mcpNames: { overrides: { delete: "delete_recipe" } },
    ports: {
      repository: {
        module: "~/server/repo/recipe/entity-adapter",
        export: "recipeEntityAdapter",
      },
      search: "document",
    },
  },
});
