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
        display: { detail: true },
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
        display: { detail: true },
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
        control: { kind: "number", section: "servings" },
        display: {
          list: true,
          detail: true,
          width: "xs",
          mobile: { slot: "subtitle", priority: 5, interactive: true },
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
        display: { detail: true },
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
        display: { list: true, detail: true },
        validation: {
          read: recipeNotes.nullable().optional(),
          create: recipeNotes.nullable().optional(),
          update: recipeNotes.nullable().optional(),
        },
      },
      {
        key: "sections",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        display: { detail: true },
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
        kind: "text",
        nullable: true,
        display: { list: true, detail: true },
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
        display: { detail: true },
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
      default: "createdAt",
      computed: ["cookbook", "costTotal", "caloriesTotal"],
      groupable: ["name"],
    },
    intents: {
      fields: {
        capture: ["name"],
        full: ["name", "cookbookId", "tags", "notes", "sections"],
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
